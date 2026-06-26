//! Integration tests for community-scoped Postgres FTS.
//!
//! Run with a local PG: `BUZZ_TEST_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz cargo test -p buzz-search --tests -- --include-ignored`
//!
//! Each test creates a uniquely-named schema, applies the consolidated `0001`
//! migration into it, exercises a scenario, and drops it. Tests are
//! parallel-safe.

use buzz_core::CommunityId;
use buzz_search::{SearchQuery, SearchService};
use sqlx::{postgres::PgPoolOptions, Executor, PgPool};
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";
const MIGRATION_SQL: &str = include_str!("../../../migrations/0001_initial_schema.sql");

async fn setup() -> (PgPool, String) {
    let url = std::env::var("BUZZ_TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.to_string());
    let schema = format!("fts_test_{}", Uuid::new_v4().simple());
    // Connect to the default schema first to create the test schema.
    let admin_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect");
    let create_sql = format!("CREATE SCHEMA \"{schema}\"");
    sqlx::query(sqlx::AssertSqlSafe(create_sql))
        .execute(&admin_pool)
        .await
        .expect("create schema");
    admin_pool.close().await;

    // Connect with search_path set so the migration's CREATE TABLE lands here.
    let url_with_search_path = format!("{url}?options=-c%20search_path%3D{schema}");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url_with_search_path)
        .await
        .expect("connect with search_path");
    pool.execute(MIGRATION_SQL)
        .await
        .expect("apply 0001 migration");
    (pool, schema)
}

async fn teardown(pool: PgPool, schema: &str) {
    pool.close().await;
    let admin_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(
            &std::env::var("BUZZ_TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.to_string()),
        )
        .await
        .expect("reconnect for drop");
    let drop_sql = format!("DROP SCHEMA \"{schema}\" CASCADE");
    sqlx::query(sqlx::AssertSqlSafe(drop_sql))
        .execute(&admin_pool)
        .await
        .expect("drop schema");
    admin_pool.close().await;
}

/// Insert a community row, return its id.
async fn mk_community(pool: &PgPool, host: &str) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host, signing_key) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(host)
        .bind(b"signingkey".as_slice())
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
}

/// Insert a minimal event. `created_at_secs` is unix seconds.
#[allow(clippy::too_many_arguments)]
async fn insert_event(
    pool: &PgPool,
    community: CommunityId,
    id: [u8; 32],
    pubkey: [u8; 32],
    kind: i32,
    content: &str,
    channel_id: Option<Uuid>,
    created_at_secs: i64,
) {
    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id) \
         VALUES ($1, $2, $3, to_timestamp($4), $5, '[]'::jsonb, $6, $7, $8)",
    )
    .bind(community.as_uuid())
    .bind(&id[..])
    .bind(&pubkey[..])
    .bind(created_at_secs)
    .bind(kind)
    .bind(content)
    .bind(b"signature".as_slice())
    .bind(channel_id)
    .execute(pool)
    .await
    .expect("insert event");
}

fn rand_bytes32() -> [u8; 32] {
    let mut out = [0u8; 32];
    let u = Uuid::new_v4();
    let bytes = u.as_bytes();
    out[..16].copy_from_slice(bytes);
    out[16..].copy_from_slice(bytes);
    out
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn search_finds_event_in_same_community() {
    let (pool, schema) = setup().await;

    let c_a = mk_community(&pool, "a.example").await;
    let evt_id = rand_bytes32();
    let pk = rand_bytes32();
    insert_event(
        &pool,
        c_a,
        evt_id,
        pk,
        1,
        "hello wonderland — buzz everyone",
        None,
        1700000000,
    )
    .await;

    let svc = SearchService::new(pool.clone());
    let result = svc
        .search(&SearchQuery {
            community: c_a,
            q: "wonderland".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .expect("search ok");

    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].event_id, evt_id);
    assert_eq!(result.hits[0].kind, 1);
    assert_eq!(result.hits[0].created_at, 1700000000);
    assert!(result.hits[0].rank > 0.0);

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn search_does_not_return_other_community_events() {
    // The load-bearing test: event indexed under community A, query bound to
    // community B → zero hits.
    let (pool, schema) = setup().await;

    let c_a = mk_community(&pool, "a.example").await;
    let c_b = mk_community(&pool, "b.example").await;
    let pk = rand_bytes32();
    insert_event(
        &pool,
        c_a,
        rand_bytes32(),
        pk,
        1,
        "only-in-a unique-token-xyz",
        None,
        1700000000,
    )
    .await;

    let svc = SearchService::new(pool.clone());
    let result_a = svc
        .search(&SearchQuery {
            community: c_a,
            q: "unique-token-xyz".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(result_a.hits.len(), 1, "A should see its own event");

    let result_b = svc
        .search(&SearchQuery {
            community: c_b,
            q: "unique-token-xyz".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(result_b.hits.len(), 0, "B must not see A's event");

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn kind0_search_by_display_name_works_without_flattening() {
    // The case I worried might regress without the kind:0 content-flattening
    // hack. Postgres FTS over raw JSON content tokenizes through the
    // punctuation and finds display_name/nip05 values.
    let (pool, schema) = setup().await;

    let c = mk_community(&pool, "a.example").await;
    let pk = rand_bytes32();
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        0,
        r#"{"display_name":"Alice Wonderland","name":"alice","nip05":"alice@buzz.app","about":"hello"}"#,
        None,
        1700000000,
    )
    .await;

    let svc = SearchService::new(pool.clone());
    for q in ["wonderland", "alice", "alice@buzz.app"] {
        let r = svc
            .search(&SearchQuery {
                community: c,
                q: q.to_string(),
                channel_ids: None,
                include_channel_less: true,
                kinds: Some(vec![0]),
                authors: None,
                since: None,
                until: None,
                page: 1,
                per_page: 10,
            })
            .await
            .unwrap();
        assert_eq!(r.hits.len(), 1, "kind:0 query {q:?} should find Alice");
    }

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn channel_scope_restricts_results() {
    let (pool, schema) = setup().await;

    let c = mk_community(&pool, "a.example").await;
    // Channels need community_id since channels PK is (community_id, id).
    let ch_a = Uuid::new_v4();
    let ch_b = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (community_id, id, name, channel_type, created_by) VALUES ($1, $2, $3, 'stream'::channel_type, $4), ($1, $5, $6, 'stream'::channel_type, $4)")
        .bind(c.as_uuid())
        .bind(ch_a)
        .bind("ch-a")
        .bind(b"\x01".repeat(32))
        .bind(ch_b)
        .bind("ch-b")
        .execute(&pool)
        .await
        .expect("insert channels");

    let pk = rand_bytes32();
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "shared-token in ch-a",
        Some(ch_a),
        1700000000,
    )
    .await;
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "shared-token in ch-b",
        Some(ch_b),
        1700000001,
    )
    .await;
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "shared-token global",
        None,
        1700000002,
    )
    .await;

    let svc = SearchService::new(pool.clone());

    // restrict to ch_a, exclude global
    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "shared-token".into(),
            channel_ids: Some(vec![ch_a]),
            include_channel_less: false,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].channel_id, Some(ch_a));

    // restrict to ch_a + include global
    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "shared-token".into(),
            channel_ids: Some(vec![ch_a]),
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 2);

    // no channel constraint
    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "shared-token".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 3);

    // empty accessible channels + exclude global = zero
    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "shared-token".into(),
            channel_ids: Some(vec![]),
            include_channel_less: false,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 0);

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn deleted_events_are_excluded() {
    let (pool, schema) = setup().await;

    let c = mk_community(&pool, "a.example").await;
    let evt_id = rand_bytes32();
    let pk = rand_bytes32();
    insert_event(&pool, c, evt_id, pk, 1, "deleted-token-q", None, 1700000000).await;

    // Soft-delete
    sqlx::query("UPDATE events SET deleted_at = NOW() WHERE community_id = $1 AND id = $2")
        .bind(c.as_uuid())
        .bind(&evt_id[..])
        .execute(&pool)
        .await
        .expect("delete");

    let svc = SearchService::new(pool.clone());
    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "deleted-token-q".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert!(
        r.hits.is_empty(),
        "soft-deleted events must not appear in FTS"
    );

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn empty_query_returns_empty_result_no_roundtrip() {
    let (pool, schema) = setup().await;
    let c = mk_community(&pool, "a.example").await;
    let svc = SearchService::new(pool.clone());

    for q in ["", "   "] {
        let r = svc
            .search(&SearchQuery {
                community: c,
                q: q.into(),
                channel_ids: None,
                include_channel_less: true,
                kinds: None,
                authors: None,
                since: None,
                until: None,
                page: 1,
                per_page: 10,
            })
            .await
            .unwrap();
        assert!(
            r.hits.is_empty(),
            "empty/whitespace query must return no hits"
        );
    }

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn since_until_filters() {
    let (pool, schema) = setup().await;

    let c = mk_community(&pool, "a.example").await;
    let pk = rand_bytes32();
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "time-token-zz at A",
        None,
        1_700_000_000,
    )
    .await;
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "time-token-zz at B",
        None,
        1_700_010_000,
    )
    .await;
    insert_event(
        &pool,
        c,
        rand_bytes32(),
        pk,
        1,
        "time-token-zz at C",
        None,
        1_700_020_000,
    )
    .await;

    let svc = SearchService::new(pool.clone());

    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "time-token-zz".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: Some(1_700_005_000),
            until: Some(1_700_015_000),
            page: 1,
            per_page: 10,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].created_at, 1_700_010_000);

    teardown(pool, &schema).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn pagination_works() {
    let (pool, schema) = setup().await;

    let c = mk_community(&pool, "a.example").await;
    let pk = rand_bytes32();
    for i in 0..7 {
        insert_event(
            &pool,
            c,
            rand_bytes32(),
            pk,
            1,
            "page-token-qq",
            None,
            1_700_000_000 + i,
        )
        .await;
    }

    let svc = SearchService::new(pool.clone());

    let r = svc
        .search(&SearchQuery {
            community: c,
            q: "page-token-qq".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 1,
            per_page: 3,
        })
        .await
        .unwrap();
    assert_eq!(r.hits.len(), 3);

    let r2 = svc
        .search(&SearchQuery {
            community: c,
            q: "page-token-qq".into(),
            channel_ids: None,
            include_channel_less: true,
            kinds: None,
            authors: None,
            since: None,
            until: None,
            page: 3,
            per_page: 3,
        })
        .await
        .unwrap();
    assert_eq!(
        r2.hits.len(),
        1,
        "page 3 of 7 with per_page=3 should have 1 hit"
    );

    teardown(pool, &schema).await;
}
