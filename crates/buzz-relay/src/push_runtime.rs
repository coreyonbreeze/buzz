//! Durable NIP-PL event matcher and gateway delivery worker.

use std::{sync::Arc, time::Duration};

use base64::Engine as _;
use buzz_core::filter::{filters_match, reader_authorized_for_event};
use chrono::{TimeDelta, Utc};
use nostr::{EventBuilder, Filter, Kind, Tag};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::{handlers::push_lease::Subscription, state::AppState};

const CLAIM_SECS: i64 = 30;
const EVENT_USEFUL_SECS: i64 = 3600;
const MAX_ATTEMPTS: i32 = 8;

// Never delete a wake until at least one day after it was created, then delete
// at most 1,000 terminal or undeliverable rows per minute. These are fixed
// safety bounds rather than deployment knobs so an accidental value cannot
// turn a maintenance tick into an unbounded transaction or indefinite
// retention.
const WAKE_REAPER_INTERVAL: Duration = Duration::from_secs(60);
const WAKE_RETENTION_SECS: i64 = 24 * 60 * 60;
const WAKE_REAPER_BATCH_SIZE: u32 = 1_000;

#[derive(Serialize)]
struct DeliveryRequest<'a> {
    v: u8,
    endpoint_grant: &'a str,
    request_id: uuid::Uuid,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
enum DeliveryResponse {
    Accepted,
    InvalidEndpoint {
        generation: i64,
        invalid_at: Option<i64>,
    },
    Retry {
        retry_after_seconds: Option<i64>,
    },
}

/// Continuously claim accepted events and match them against active leases.
pub async fn run_matcher(state: Arc<AppState>) {
    loop {
        let until = Utc::now() + TimeDelta::seconds(CLAIM_SECS);
        match state.db.claim_due_push_match(until).await {
            Ok(Some(job)) => {
                if let Err(e) = process_match(&state, &job).await {
                    warn!(event_id=%job.event.event.id, attempt=job.attempt, "push match failed: {e}");
                    if job.attempt >= buzz_db::push::MAX_MATCH_ATTEMPTS {
                        // A poison event/lease must not retry forever or pin
                        // delivered outbox retention through the rematch guard.
                        let _ = state.db.complete_push_match(&job).await;
                    } else {
                        let _ = state
                            .db
                            .retry_push_match(&job, Utc::now() + TimeDelta::seconds(2))
                            .await;
                    }
                } else if let Err(e) = state.db.complete_push_match(&job).await {
                    warn!(event_id=%job.event.event.id, "push match completion failed: {e}");
                }
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(250)).await,
            Err(e) => {
                error!("push matcher claim failed: {e}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// Empty a pre-existing matcher backlog after push has been disabled.
///
/// Trigger-side admission is disabled before this task starts, so every
/// successful batch moves the deployment toward an empty queue. Multiple pods
/// can run the drainer safely because the database claim uses `SKIP LOCKED`.
pub async fn drain_disabled_matcher(state: Arc<AppState>) {
    loop {
        match state.db.discard_push_match_jobs().await {
            Ok(0) => {
                info!("disabled push matcher backlog is empty");
                return;
            }
            Ok(deleted) => {
                info!(deleted, "discarded disabled push matcher jobs");
                tokio::task::yield_now().await;
            }
            Err(e) => {
                error!("disabled push matcher drain failed: {e}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn process_match(state: &AppState, job: &buzz_db::push::ClaimedMatch) -> anyhow::Result<()> {
    let leases = state.db.active_push_match_leases(job.community).await?;
    for lease in leases {
        let author_hex = hex::encode(&lease.author);
        if !reader_authorized_for_event(&job.event.event, &author_hex) {
            continue;
        }
        let subscriptions: Vec<Subscription> = serde_json::from_value(lease.subscriptions.clone())?;
        let mut class: Option<&str> = None;
        for sub in &subscriptions {
            let filter: Filter =
                serde_json::from_value(serde_json::Value::Object(sub.filter.clone()))?;
            if !push_filter_authorized_for_event(&filter, &job.event.event, &author_hex)
                || !filters_match(std::slice::from_ref(&filter), &job.event)
            {
                continue;
            }
            let ignored = sub.ignore.iter().any(|raw| {
                serde_json::from_value::<Filter>(serde_json::Value::Object(raw.clone()))
                    .is_ok_and(|f| filters_match(&[f], &job.event))
            });
            let p_count = job
                .event
                .event
                .tags
                .iter()
                .filter(|t| t.kind().to_string() == "p")
                .count() as u64;
            if ignored
                || sub
                    .suppress
                    .as_ref()
                    .is_some_and(|s| p_count > s.p_tags_max)
            {
                continue;
            }
            if class.is_none_or(|old| class_rank(&sub.class) > class_rank(old)) {
                class = Some(&sub.class);
            }
        }
        let Some(class) = class else { continue };
        // Most leases do not match a given event. Apply their pure filter and
        // reader checks before spending a database round trip on channel
        // membership; authorization is still required before enqueue.
        if let Some(channel) = job.event.channel_id {
            if !state
                .db
                .is_member(job.community, channel, &lease.author)
                .await?
            {
                continue;
            }
        }
        let event_deadline = job.event.event.created_at.as_secs() as i64 + EVENT_USEFUL_SECS;
        let expires_at = lease.expires_at.min(event_deadline);
        if expires_at <= Utc::now().timestamp() {
            continue;
        }
        let outcome = state
            .db
            .enqueue_push_wake(
                job.community,
                &lease.author,
                &lease.installation_id,
                buzz_db::push::NewWake {
                    lease_generation: lease.generation,
                    event_id: job.event.event.id.as_bytes(),
                    class,
                    expires_at,
                },
            )
            .await?;
        if matches!(outcome, buzz_db::push::EnqueueWakeOutcome::CapacityExceeded) {
            metrics::counter!("buzz_push_wake_admission_drops_total").increment(1);
        }
    }
    Ok(())
}

/// Match-time counterpart of REQ's filter-level `#p` authorization gate.
/// Kind 1059 is globally stored and leaks recipient activity through wake
/// timing, so a lease may only match gift wraps addressed to its own author.
fn push_filter_authorized_for_event(
    filter: &Filter,
    event: &nostr::Event,
    lease_author_hex: &str,
) -> bool {
    if buzz_core::kind::event_kind_u32(event) != buzz_core::kind::KIND_GIFT_WRAP {
        return true;
    }
    let p = nostr::SingleLetterTag::lowercase(nostr::Alphabet::P);
    filter.generic_tags.get(&p).is_some_and(|values| {
        !values.is_empty()
            && values.iter().all(|value| value == lease_author_hex)
            && event
                .tags
                .filter(nostr::TagKind::SingleLetter(p))
                .any(|tag| tag.content() == Some(lease_author_hex))
    })
}

/// Continuously claim due wakes and deliver them through the push gateway.
pub async fn run_delivery_worker(state: Arc<AppState>) {
    let http = reqwest::Client::builder()
        .timeout(state.config.push_gateway_timeout)
        .build()
        .expect("push HTTP client");
    loop {
        let mut found = false;
        match state.db.usage_community_hosts().await {
            Ok(communities) => {
                for community in communities {
                    let community = buzz_core::CommunityId::from_uuid(community.id);
                    let until = Utc::now() + TimeDelta::seconds(CLAIM_SECS);
                    match state.db.claim_due_push_wakes(community, 16, until).await {
                        Ok(wakes) => {
                            for wake in wakes {
                                found = true;
                                deliver_one(&state, &http, wake).await;
                            }
                        }
                        Err(e) => warn!(%community, "push wake claim failed: {e}"),
                    }
                }
            }
            Err(e) => error!("push worker community scan failed: {e}"),
        }
        if !found {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

/// Reap retained push wakes until relay shutdown is signalled.
///
/// A tick runs immediately and then once per minute. Each transaction deletes
/// at most 1,000 rows whose creation time is over 24 hours old and whose state
/// is terminal, expired, abandoned, or no longer backed by an effective lease.
pub async fn run_wake_outbox_reaper(state: Arc<AppState>, cancel: CancellationToken) {
    info!(
        interval_secs = WAKE_REAPER_INTERVAL.as_secs(),
        retention_secs = WAKE_RETENTION_SECS,
        batch_size = WAKE_REAPER_BATCH_SIZE,
        "push wake outbox reaper started"
    );
    run_wake_outbox_reaper_loop(WAKE_REAPER_INTERVAL, cancel, move || {
        let state = Arc::clone(&state);
        async move { run_wake_outbox_reaper_tick(&state).await }
    })
    .await;
    info!("push wake outbox reaper stopped");
}

async fn run_wake_outbox_reaper_loop<Tick, TickFuture>(
    period: Duration,
    cancel: CancellationToken,
    mut tick: Tick,
) where
    Tick: FnMut() -> TickFuture,
    TickFuture: std::future::Future<Output = ()>,
{
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = interval.tick() => tick().await,
        }
    }
}

async fn run_wake_outbox_reaper_tick(state: &AppState) {
    let before = Utc::now() - TimeDelta::seconds(WAKE_RETENTION_SECS);
    match state
        .db
        .prune_push_wake_outbox(before, WAKE_REAPER_BATCH_SIZE)
        .await
    {
        Ok(deleted) => {
            metrics::counter!(
                "buzz_push_wake_reaper_ticks_total",
                "outcome" => "success"
            )
            .increment(1);
            metrics::counter!("buzz_push_wake_reaper_rows_total").increment(deleted);
            if deleted > 0 {
                info!(deleted, "pruned retained push wake rows");
            }
        }
        Err(error) => {
            metrics::counter!(
                "buzz_push_wake_reaper_ticks_total",
                "outcome" => "error"
            )
            .increment(1);
            warn!(%error, "push wake outbox reaper tick failed");
        }
    }
}

async fn deliver_one(
    state: &AppState,
    http: &reqwest::Client,
    claimed: buzz_db::push::ClaimedWake,
) {
    let outcome = match state
        .db
        .revalidate_push_wake(claimed.community, claimed.id, claimed.claim_id)
        .await
    {
        Ok(buzz_db::push::RevalidateWakeOutcome::Deliver(wake)) => wake,
        Ok(buzz_db::push::RevalidateWakeOutcome::Suppressed) => {
            let _ = state
                .db
                .fail_push_wake(claimed.community, claimed.id, claimed.claim_id)
                .await;
            return;
        }
        Err(e) => {
            warn!(wake=%claimed.id, "push revalidation failed: {e}");
            return;
        }
    };
    if let Some(channel) = outcome.channel_id {
        match state
            .db
            .is_member(outcome.community, channel, &outcome.author)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                let _ = state
                    .db
                    .fail_push_wake(outcome.community, outcome.id, outcome.claim_id)
                    .await;
                return;
            }
            Err(e) => {
                warn!(wake=%outcome.id, "push membership revalidation failed: {e}");
                let _ = state
                    .db
                    .retry_push_wake(
                        outcome.community,
                        outcome.id,
                        outcome.claim_id,
                        Utc::now() + TimeDelta::seconds(2),
                    )
                    .await;
                return;
            }
        }
    }
    // Membership I/O above can race lease replacement. Re-run the generation
    // fence as the final database operation before transport.
    let outcome = match state
        .db
        .revalidate_push_wake(outcome.community, outcome.id, outcome.claim_id)
        .await
    {
        Ok(buzz_db::push::RevalidateWakeOutcome::Deliver(wake)) => wake,
        Ok(buzz_db::push::RevalidateWakeOutcome::Suppressed) => {
            let _ = state
                .db
                .fail_push_wake(outcome.community, outcome.id, outcome.claim_id)
                .await;
            return;
        }
        Err(e) => {
            warn!(wake=%outcome.id, "final push revalidation failed: {e}");
            return;
        }
    };
    let Some(url) = state.config.push_gateway_delivery_url.as_ref() else {
        return;
    };
    let body = delivery_body(&outcome.endpoint_grant, outcome.id, outcome.expires_at);
    let auth = match nip98_header(&state.relay_keypair, url.as_str(), &body) {
        Ok(auth) => auth,
        Err(e) => {
            warn!(wake=%outcome.id, "push auth failed: {e}");
            return;
        }
    };
    let response = send_gateway_request(http, url, body, auth).await;
    match response {
        Ok(r) if r.status().is_success() => match r.json::<DeliveryResponse>().await {
            Ok(DeliveryResponse::Accepted) => {
                let _ = state
                    .db
                    .complete_push_wake(outcome.community, outcome.id, outcome.claim_id)
                    .await;
            }
            _ => {
                let _ = state
                    .db
                    .fail_push_wake(outcome.community, outcome.id, outcome.claim_id)
                    .await;
            }
        },
        Ok(r) if r.status() == reqwest::StatusCode::GONE => {
            match r.json::<DeliveryResponse>().await {
                Ok(DeliveryResponse::InvalidEndpoint {
                    generation,
                    invalid_at,
                }) => {
                    if generation == outcome.lease_generation {
                        let _ = state
                            .db
                            .disable_push_endpoint(
                                outcome.community,
                                &outcome.author,
                                &outcome.installation_id,
                                generation,
                            )
                            .await;
                    }
                    warn!(wake=%outcome.id, ?invalid_at, "push endpoint permanently invalid");
                }
                _ => warn!(wake=%outcome.id, "invalid closed-protocol 410 response"),
            }
            let _ = state
                .db
                .fail_push_wake(outcome.community, outcome.id, outcome.claim_id)
                .await;
        }
        Ok(r) if r.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => {
            let delay = match r.json::<DeliveryResponse>().await {
                Ok(DeliveryResponse::Retry {
                    retry_after_seconds,
                }) => retry_after_seconds
                    .filter(|seconds| *seconds > 0)
                    .unwrap_or(2),
                _ => 2,
            };
            retry_or_fail(state, &outcome, delay).await;
        }
        Ok(r) if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            retry_or_fail(state, &outcome, 2).await
        }
        // A timed-out terminal attempt burns the stable request id. Its replay
        // is indistinguishable from another invalid-grant 404, but sending a
        // fresh id would double-deliver and defeat the gateway replay fence.
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND && outcome.attempt > 1 => {
            let _ = state
                .db
                .complete_push_wake(outcome.community, outcome.id, outcome.claim_id)
                .await;
        }
        Err(e) if e.is_timeout() || e.is_connect() => retry_or_fail(state, &outcome, 2).await,
        _ => {
            let _ = state
                .db
                .fail_push_wake(outcome.community, outcome.id, outcome.claim_id)
                .await;
        }
    }
}

fn delivery_body(endpoint_grant: &str, request_id: uuid::Uuid, expires_at: i64) -> Vec<u8> {
    serde_json::to_vec(&DeliveryRequest {
        v: 1,
        endpoint_grant,
        request_id,
        expires_at,
    })
    .expect("closed delivery body")
}

async fn send_gateway_request(
    http: &reqwest::Client,
    url: &url::Url,
    body: Vec<u8>,
    auth: String,
) -> reqwest::Result<reqwest::Response> {
    http.post(url.clone())
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
}

async fn retry_or_fail(state: &AppState, wake: &buzz_db::push::ClaimedWake, delay: i64) {
    if wake.attempt >= MAX_ATTEMPTS {
        let _ = state
            .db
            .fail_push_wake(wake.community, wake.id, wake.claim_id)
            .await;
    } else {
        let secs = delay * (1_i64 << (wake.attempt - 1).clamp(0, 6));
        let _ = state
            .db
            .retry_push_wake(
                wake.community,
                wake.id,
                wake.claim_id,
                Utc::now() + TimeDelta::seconds(secs),
            )
            .await;
    }
}

fn nip98_header(keys: &nostr::Keys, url: &str, body: &[u8]) -> anyhow::Result<String> {
    let hash = hex::encode(Sha256::digest(body));
    let event = EventBuilder::new(Kind::HttpAuth, "")
        .tags([
            Tag::parse(["u", url])?,
            Tag::parse(["method", "POST"])?,
            Tag::parse(["payload", &hash])?,
            Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()])?,
        ])
        .sign_with_keys(keys)?;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&event)?)
    ))
}

fn class_rank(class: &str) -> u8 {
    match class {
        "silent" => 0,
        "default" => 1,
        "time_sensitive" => 2,
        "urgent" => 3,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::Value;
    use std::{
        future::IntoFuture,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    use tokio::sync::Mutex;

    #[tokio::test(start_paused = true)]
    async fn wake_reaper_ticks_immediately_and_cancels_without_waiting() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let ticks = Arc::new(AtomicUsize::new(0));
        let task_ticks = Arc::clone(&ticks);
        let task = tokio::spawn(async move {
            run_wake_outbox_reaper_loop(Duration::from_secs(60), task_cancel, move || {
                let ticks = Arc::clone(&task_ticks);
                async move {
                    ticks.fetch_add(1, Ordering::Relaxed);
                }
            })
            .await;
        });

        tokio::task::yield_now().await;
        assert_eq!(ticks.load(Ordering::Relaxed), 1);
        cancel.cancel();
        tokio::time::timeout(Duration::from_millis(1), task)
            .await
            .expect("reaper cancellation must not wait for the next interval")
            .expect("join reaper task");
    }

    #[test]
    fn gift_wrap_match_requires_self_p_filter_and_recipient() {
        let recipient = nostr::Keys::generate();
        let other = nostr::Keys::generate();
        let sender = nostr::Keys::generate();
        let recipient_hex = recipient.public_key().to_hex();
        let event = EventBuilder::new(Kind::GiftWrap, "ciphertext")
            .tag(Tag::public_key(other.public_key()))
            .sign_with_keys(&sender)
            .unwrap();
        let self_filter = Filter::new().pubkey(recipient.public_key());
        assert!(!push_filter_authorized_for_event(
            &self_filter,
            &event,
            &recipient_hex
        ));

        let event = EventBuilder::new(Kind::GiftWrap, "ciphertext")
            .tag(Tag::public_key(recipient.public_key()))
            .sign_with_keys(&sender)
            .unwrap();
        assert!(push_filter_authorized_for_event(
            &self_filter,
            &event,
            &recipient_hex
        ));
        assert!(!push_filter_authorized_for_event(
            &Filter::new().author(sender.public_key()),
            &event,
            &recipient_hex
        ));
    }

    async fn capture(
        State(seen): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        seen.lock().await.push(body);
        Json(serde_json::json!({"status":"accepted"}))
    }

    #[tokio::test]
    async fn gateway_retries_send_the_same_request_id_over_http() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/deliver", post(capture))
                    .with_state(seen.clone()),
            )
            .into_future(),
        );
        let url: url::Url = format!("http://{address}/deliver").parse().unwrap();
        let http = reqwest::Client::new();
        let keys = nostr::Keys::generate();
        let request_id = uuid::Uuid::new_v4();
        for _ in 0..2 {
            let body = delivery_body("opaque-grant", request_id, Utc::now().timestamp() + 60);
            let auth = nip98_header(&keys, url.as_str(), &body).unwrap();
            let response = send_gateway_request(&http, &url, body, auth).await.unwrap();
            assert!(response.status().is_success());
        }
        server.abort();
        let bodies = seen.lock().await;
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0]["request_id"], request_id.to_string());
        assert_eq!(bodies[1]["request_id"], request_id.to_string());
    }
}
