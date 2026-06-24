#![deny(unsafe_code)]
#![warn(missing_docs)]
//! Buzz search — pluggable full-text event search.
//!
//! Two production backends and a no-op:
//!
//! - [`SearchService::new`] (Typesense): mirrors event content into a Typesense
//!   collection via the indexing worker in `buzz-relay/src/state.rs`. The
//!   `search()` path returns event IDs that the relay then refetches from
//!   Postgres.
//! - [`SearchService::with_postgres`] (Postgres FTS): runs `plainto_tsquery`
//!   against a generated `content_tsv` column on `events`. No write-path
//!   indexing needed — the generated stored column auto-populates on INSERT.
//! - [`SearchService::disabled`]: returns empty results for every query and
//!   accepts indexing calls as no-ops. Used when NIP-50 search is intentionally
//!   off (e.g. for tenants who opted out).
//!
//! The choice is driven by [`SearchBackend`] on [`SearchConfig`].

/// Typesense collection schema management.
pub mod collection;
/// Search error types.
pub mod error;
/// Event indexing helpers (Typesense).
pub mod index;
/// Postgres full-text-search backend.
pub mod postgres;
/// Search query types and Typesense execution.
pub mod query;

pub use error::SearchError;
pub use query::{SearchHit, SearchQuery, SearchResult, GLOBAL_CHANNEL_SENTINEL};

use buzz_core::event::StoredEvent;
use sqlx::PgPool;

/// Which search backend the relay should use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchBackend {
    /// Typesense (current production default).
    Typesense,
    /// Postgres full-text search via the `content_tsv` generated column.
    Postgres,
    /// NIP-50 search is disabled; every query returns empty.
    Disabled,
}

impl SearchBackend {
    /// Parses a backend name from a string. Case-insensitive. Accepted values:
    /// `typesense`, `postgres` (alias `pg`), `disabled` (aliases `off`, `none`).
    /// Returns `Err(<input>)` on any other value so misconfiguration surfaces
    /// loudly rather than silently falling back.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "typesense" => Ok(Self::Typesense),
            "postgres" | "pg" => Ok(Self::Postgres),
            "disabled" | "off" | "none" => Ok(Self::Disabled),
            other => Err(other.to_string()),
        }
    }
}

/// Configuration for the search backend.
///
/// Reading from env via [`SearchConfig::default`] selects the Typesense
/// backend by default. For Postgres or Disabled backends, set
/// `BUZZ_SEARCH_BACKEND` in `buzz-relay/src/config.rs` and pass the resolved
/// [`SearchBackend`] into the constructors directly — this struct only carries
/// Typesense-specific fields.
///
/// | Field        | Environment variable    | Default (dev only)       |
/// |--------------|-------------------------|--------------------------|
/// | `url`        | `TYPESENSE_URL`         | `http://localhost:8108`  |
/// | `api_key`    | `TYPESENSE_API_KEY`     | `buzz_dev_key`           |
/// | `collection` | `TYPESENSE_COLLECTION`  | `events`                 |
///
/// In production, always set `TYPESENSE_API_KEY` explicitly. The fallback
/// value `buzz_dev_key` is intentionally weak and only suitable for local
/// development with a locally-running Typesense instance.
#[derive(Debug, Clone)]
pub struct SearchConfig {
    /// Typesense base URL (e.g. `http://localhost:8108`).
    pub url: String,
    /// Typesense API key.
    pub api_key: String,
    /// Collection name to use for events.
    pub collection: String,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            url: std::env::var("TYPESENSE_URL").unwrap_or_else(|_| "http://localhost:8108".into()),
            api_key: std::env::var("TYPESENSE_API_KEY").unwrap_or_else(|_| "buzz_dev_key".into()),
            collection: std::env::var("TYPESENSE_COLLECTION").unwrap_or_else(|_| "events".into()),
        }
    }
}

/// Internal Typesense client + config bundle. Construction is handled via
/// [`SearchService::new`] / [`SearchService::with_client`]; this type is
/// exposed only because it appears in a public enum variant.
#[derive(Debug, Clone)]
pub struct TypesenseInner {
    client: reqwest::Client,
    config: SearchConfig,
}

/// Pluggable search client. Construct via [`SearchService::new`] (Typesense),
/// [`SearchService::with_postgres`] (Postgres FTS), or
/// [`SearchService::disabled`] (no-op).
#[derive(Debug, Clone)]
pub enum SearchService {
    /// Typesense backend.
    Typesense(TypesenseInner),
    /// Postgres FTS backend, holding the relay's existing `PgPool`.
    Postgres(PgPool),
    /// No-op backend; every search returns empty.
    Disabled,
}

impl SearchService {
    /// Creates a Typesense `SearchService` with a default HTTP client.
    pub fn new(config: SearchConfig) -> Self {
        // SAFETY: default builder with only timeout/connect_timeout config cannot fail
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("SAFETY: default builder with only timeout config cannot fail");
        Self::Typesense(TypesenseInner { client, config })
    }

    /// Creates a Typesense `SearchService` with an explicit HTTP client
    /// (useful in tests).
    pub fn with_client(client: reqwest::Client, config: SearchConfig) -> Self {
        Self::Typesense(TypesenseInner { client, config })
    }

    /// Creates a Postgres FTS `SearchService` backed by the supplied pool.
    /// No indexing setup is required — the `content_tsv` generated column
    /// populates on every INSERT.
    pub fn with_postgres(pool: PgPool) -> Self {
        Self::Postgres(pool)
    }

    /// Creates a no-op `SearchService` that returns empty results for every
    /// query. Useful when search is intentionally disabled.
    pub fn disabled() -> Self {
        Self::Disabled
    }

    /// Ensures the backend is ready to serve search.
    ///
    /// - **Typesense**: creates the configured collection if it doesn't exist.
    /// - **Postgres / Disabled**: no-op.
    ///
    /// Idempotent — safe to call on every startup.
    pub async fn ensure_collection(&self) -> Result<(), SearchError> {
        match self {
            Self::Typesense(t) => {
                collection::ensure_collection(
                    &t.client,
                    &t.config.url,
                    &t.config.api_key,
                    &t.config.collection,
                )
                .await
            }
            Self::Postgres(_) | Self::Disabled => Ok(()),
        }
    }

    /// Indexes a single event (upsert semantics).
    ///
    /// - **Typesense**: writes a document to the collection.
    /// - **Postgres**: no-op — the `content_tsv` generated stored column is
    ///   populated automatically on the original INSERT.
    /// - **Disabled**: no-op.
    pub async fn index_event(&self, event: &StoredEvent) -> Result<(), SearchError> {
        match self {
            Self::Typesense(t) => {
                index::index_event(
                    &t.client,
                    &t.config.url,
                    &t.config.api_key,
                    &t.config.collection,
                    event,
                )
                .await
            }
            Self::Postgres(_) | Self::Disabled => Ok(()),
        }
    }

    /// Indexes a batch of events. Returns the number successfully indexed.
    /// For Postgres and Disabled backends, returns `events.len()` (no work).
    pub async fn index_batch(&self, events: &[StoredEvent]) -> Result<usize, SearchError> {
        match self {
            Self::Typesense(t) => {
                index::index_batch(
                    &t.client,
                    &t.config.url,
                    &t.config.api_key,
                    &t.config.collection,
                    events,
                )
                .await
            }
            Self::Postgres(_) | Self::Disabled => Ok(events.len()),
        }
    }

    /// Executes a search query and returns matching results.
    pub async fn search(&self, query: &SearchQuery) -> Result<SearchResult, SearchError> {
        match self {
            Self::Typesense(t) => {
                query::search(
                    &t.client,
                    &t.config.url,
                    &t.config.api_key,
                    &t.config.collection,
                    query,
                )
                .await
            }
            Self::Postgres(pool) => postgres::search(pool, query).await,
            Self::Disabled => Ok(SearchResult {
                hits: Vec::new(),
                found: 0,
                page: query.page,
            }),
        }
    }

    /// Removes an event from the search index by its event ID hex string.
    ///
    /// - **Typesense**: deletes the document.
    /// - **Postgres**: no-op — `content_tsv` is tied to the event row;
    ///   removing the row removes the index entry, and the relay's event
    ///   deletion path already handles that.
    /// - **Disabled**: no-op.
    pub async fn delete_event(&self, event_id: &str) -> Result<(), SearchError> {
        match self {
            Self::Typesense(t) => {
                index::delete_event(
                    &t.client,
                    &t.config.url,
                    &t.config.api_key,
                    &t.config.collection,
                    event_id,
                )
                .await
            }
            Self::Postgres(_) | Self::Disabled => Ok(()),
        }
    }

    /// Checks that the backend is reachable and healthy.
    pub async fn health_check(&self) -> Result<(), SearchError> {
        match self {
            Self::Typesense(t) => {
                let url = format!("{}/health", t.config.url);
                let resp = t
                    .client
                    .get(&url)
                    .header("X-TYPESENSE-API-KEY", &t.config.api_key)
                    .send()
                    .await?;

                let status = resp.status().as_u16();
                if status == 200 {
                    Ok(())
                } else {
                    let body = resp.text().await.unwrap_or_default();
                    Err(SearchError::Api { status, body })
                }
            }
            Self::Postgres(pool) => {
                sqlx::query_scalar::<_, i32>("SELECT 1")
                    .fetch_one(pool)
                    .await?;
                Ok(())
            }
            Self::Disabled => Ok(()),
        }
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind};
    use uuid::Uuid;

    async fn typesense_available() -> bool {
        let client = reqwest::Client::new();
        client
            .get("http://localhost:8108/health")
            .header("X-TYPESENSE-API-KEY", "buzz_dev_key")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    fn make_service(collection: &str) -> (SearchService, SearchConfig, reqwest::Client) {
        let config = SearchConfig {
            url: "http://localhost:8108".into(),
            api_key: "buzz_dev_key".into(),
            collection: collection.to_string(),
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("client");
        let service = SearchService::with_client(client.clone(), config.clone());
        (service, config, client)
    }

    fn make_stored_event(content: &str, kind: Kind) -> StoredEvent {
        let keys = Keys::generate();
        let event = EventBuilder::new(kind, content)
            .tags([])
            .sign_with_keys(&keys)
            .expect("signing failed");
        StoredEvent::new(event, None)
    }

    async fn drop_collection(config: &SearchConfig, client: &reqwest::Client) {
        let url = format!("{}/collections/{}", config.url, config.collection);
        let _ = client
            .delete(&url)
            .header("X-TYPESENSE-API-KEY", &config.api_key)
            .send()
            .await;
    }

    #[tokio::test]
    #[ignore = "requires Typesense"]
    async fn ensure_collection_idempotent() {
        if !typesense_available().await {
            return;
        }
        let collection = format!("events_test_{}", Uuid::new_v4().simple());
        let (service, config, client) = make_service(&collection);
        service.ensure_collection().await.expect("first call");
        service
            .ensure_collection()
            .await
            .expect("idempotency check");
        drop_collection(&config, &client).await;
    }

    #[tokio::test]
    #[ignore = "requires Typesense"]
    async fn index_and_search_roundtrip() {
        if !typesense_available().await {
            return;
        }
        let collection = format!("events_test_{}", Uuid::new_v4().simple());
        let (service, config, client) = make_service(&collection);
        service.ensure_collection().await.unwrap();

        let unique_token = format!("buzz_search_test_{}", Uuid::new_v4().simple());
        let stored = make_stored_event(&format!("hello {}", unique_token), Kind::TextNote);
        let event_id = stored.event.id.to_string();

        service.index_event(&stored).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let result = service
            .search(
                &SearchQuery::new(
                    unique_token.clone(),
                    vec![GLOBAL_CHANNEL_SENTINEL.to_string()],
                )
                .expect("non-empty scope"),
            )
            .await
            .unwrap();

        assert!(result.found >= 1);
        assert_eq!(result.hits[0].event_id, event_id);
        assert!(result.hits[0].content.contains(&unique_token));

        drop_collection(&config, &client).await;
    }

    #[tokio::test]
    #[ignore = "requires Typesense"]
    async fn index_batch_and_delete() {
        if !typesense_available().await {
            return;
        }
        let collection = format!("events_test_{}", Uuid::new_v4().simple());
        let (service, config, client) = make_service(&collection);
        service.ensure_collection().await.unwrap();

        let events: Vec<StoredEvent> = (0..5)
            .map(|i| make_stored_event(&format!("batch event {i}"), Kind::TextNote))
            .collect();
        let count = service.index_batch(&events).await.unwrap();
        assert_eq!(count, 5);

        let stored = make_stored_event("to be deleted", Kind::TextNote);
        let event_id = stored.event.id.to_string();
        service.index_event(&stored).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        service.delete_event(&event_id).await.unwrap();
        service.delete_event(&event_id).await.unwrap(); // idempotent

        drop_collection(&config, &client).await;
    }

    #[tokio::test]
    #[ignore = "requires Typesense"]
    async fn search_with_kind_filter() {
        if !typesense_available().await {
            return;
        }
        let collection = format!("events_test_{}", Uuid::new_v4().simple());
        let (service, config, client) = make_service(&collection);
        service.ensure_collection().await.unwrap();

        let unique = format!("filter_test_{}", Uuid::new_v4().simple());
        let event_k1 = make_stored_event(&format!("{unique} kind1"), Kind::TextNote);
        let event_k42 = make_stored_event(&format!("{unique} kind42"), Kind::from(42u16));
        service.index_batch(&[event_k1, event_k42]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let result = service
            .search(
                &SearchQuery::new(unique.clone(), vec![GLOBAL_CHANNEL_SENTINEL.to_string()])
                    .expect("non-empty scope")
                    .with_kinds(vec![1]),
            )
            .await
            .unwrap();

        for hit in &result.hits {
            assert_eq!(hit.kind, 1);
        }

        drop_collection(&config, &client).await;
    }

    #[tokio::test]
    async fn disabled_backend_returns_empty_results() {
        let service = SearchService::disabled();
        let query = SearchQuery::new("*", vec![GLOBAL_CHANNEL_SENTINEL.to_string()])
            .expect("non-empty scope");
        let result = service.search(&query).await.unwrap();
        assert_eq!(result.found, 0);
        assert!(result.hits.is_empty());

        // index_* and delete_* are no-ops, but exercise them so future changes
        // that re-introduce side effects break this test loudly.
        let keys = nostr::Keys::generate();
        let event = nostr::EventBuilder::new(nostr::Kind::TextNote, "hello")
            .tags([])
            .sign_with_keys(&keys)
            .expect("sign");
        let stored = StoredEvent::new(event, None);
        service.index_event(&stored).await.unwrap();
        assert_eq!(service.index_batch(&[stored]).await.unwrap(), 1);
        service.delete_event("0".repeat(64).as_str()).await.unwrap();
        service.health_check().await.unwrap();
        service.ensure_collection().await.unwrap();
    }
}
