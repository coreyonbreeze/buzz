//! NIP-50 search query against Postgres FTS, community-scoped.
//!
//! The relay never trusts a hit by itself: this layer returns canonical event
//! ids ordered by relevance, the relay refetches `StoredEvent`s through
//! buzz-db's `(community_id, event_id)` scoped fetcher, and runs the access
//! predicate (`search_hit_accepted` in `bridge.rs`) per hit. Search is never
//! the access boundary — it cannot widen visibility.
//!
//! See conformance row 50.

use buzz_core::CommunityId;
use sqlx::{PgPool, QueryBuilder, Row};
use uuid::Uuid;

use crate::error::SearchError;

/// A community-scoped FTS query.
///
/// The community is REQUIRED at the type level — there is no construction path
/// that omits it. This is the search-side expression of conformance row zero:
/// every search call carries the server-resolved tenant, never client input.
#[derive(Debug, Clone)]
pub struct SearchQuery {
    /// Server-resolved community. Required.
    pub community: CommunityId,
    /// NIP-50 search text. Empty string is rejected by `search()` early
    /// (no hits, no SQL roundtrip).
    pub q: String,
    /// Restrict hits to one of these channel UUIDs. `None` = no channel
    /// constraint (community-global within the community). An empty `Some(vec![])`
    /// is also treated as "no channel constraint" — call sites that mean
    /// "no channels are accessible" must short-circuit before calling.
    pub channel_ids: Option<Vec<Uuid>>,
    /// If `true`, include channel-less events (channel_id IS NULL) in addition
    /// to any `channel_ids` filter. If `channel_ids` is `None`, this is
    /// implicitly satisfied. Maps to today's `__global__` sentinel semantic.
    pub include_channel_less: bool,
    /// NIP-01 kinds filter. None = no kind constraint.
    pub kinds: Option<Vec<i32>>,
    /// NIP-01 authors filter (32-byte pubkeys). None = no author constraint.
    pub authors: Option<Vec<Vec<u8>>>,
    /// NIP-01 since (Unix seconds). Inclusive lower bound on created_at.
    pub since: Option<i64>,
    /// NIP-01 until (Unix seconds). Inclusive upper bound on created_at.
    pub until: Option<i64>,
    /// 1-indexed page number.
    pub page: u32,
    /// Page size. Clamped at 500 internally.
    pub per_page: u32,
}

/// A single FTS hit. The relay refetches the canonical `StoredEvent` and
/// re-authorizes; this struct is just enough to drive that fetch and preserve
/// relevance ordering.
#[derive(Debug, Clone)]
pub struct SearchHit {
    /// 32-byte event id.
    pub event_id: [u8; 32],
    /// Nostr kind.
    pub kind: i32,
    /// 32-byte pubkey of author.
    pub pubkey: [u8; 32],
    /// Optional channel UUID. `None` = channel-less event.
    pub channel_id: Option<Uuid>,
    /// Unix seconds.
    pub created_at: i64,
    /// `ts_rank_cd` relevance score (higher = better).
    pub rank: f32,
}

/// Result of a search.
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Hits on this page, ordered by relevance then created_at desc.
    pub hits: Vec<SearchHit>,
    /// 1-indexed page returned.
    pub page: u32,
}

const PER_PAGE_MAX: u32 = 500;
const PER_PAGE_DEFAULT: u32 = 100;

/// Execute a community-scoped FTS query.
///
/// SQL shape (always):
/// ```sql
/// SELECT id, kind, pubkey, channel_id, EXTRACT(EPOCH FROM created_at)::bigint AS created_at_s,
///        ts_rank_cd(search_tsv, query) AS rank
/// FROM events,
///      websearch_to_tsquery('simple', $q) AS query
/// WHERE community_id = $ctx
///   AND deleted_at IS NULL
///   AND search_tsv @@ query
///   [+ channel scope, kinds, authors, since, until]
/// ORDER BY rank DESC, created_at DESC, id
/// LIMIT $per_page OFFSET (($page - 1) * $per_page)
/// ```
///
/// `community_id = $ctx` is the first predicate and is non-negotiable. There
/// is no code path through this function that omits it.
pub async fn search(pool: &PgPool, query: &SearchQuery) -> Result<SearchResult, SearchError> {
    let trimmed = query.q.trim();
    if trimmed.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            page: query.page.max(1),
        });
    }

    let per_page = query.per_page.clamp(1, PER_PAGE_MAX);
    let per_page_actual = if query.per_page == 0 {
        PER_PAGE_DEFAULT
    } else {
        per_page
    };
    let page = query.page.max(1);
    let offset = ((page - 1) as i64) * (per_page_actual as i64);

    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, kind, pubkey, channel_id, \
         EXTRACT(EPOCH FROM created_at)::bigint AS created_at_s, \
         ts_rank_cd(search_tsv, query) AS rank \
         FROM events, websearch_to_tsquery('simple', ",
    );
    qb.push_bind(trimmed);
    qb.push(") AS query WHERE community_id = ");
    qb.push_bind(*query.community.as_uuid());
    qb.push(" AND deleted_at IS NULL AND search_tsv @@ query");

    // Channel scope. Three shapes:
    //   - channel_ids = Some([..]) + include_channel_less = true:  (channel_id = ANY($) OR channel_id IS NULL)
    //   - channel_ids = Some([..]) + include_channel_less = false: channel_id = ANY($)
    //   - channel_ids = None + include_channel_less = true:        (no constraint — also covers None/false for callers
    //                                                               that explicitly want "no channel scope at all")
    //   - channel_ids = None + include_channel_less = false:       caller meant "nothing accessible" but didn't
    //                                                               short-circuit; we conservatively return no hits
    match (&query.channel_ids, query.include_channel_less) {
        (Some(ids), include_global) if !ids.is_empty() => {
            qb.push(" AND (channel_id = ANY(");
            qb.push_bind(ids.clone());
            if include_global {
                qb.push(") OR channel_id IS NULL)");
            } else {
                qb.push("))");
            }
        }
        (Some(_), true) | (None, true) => {
            // No channel constraint — include everything in the community.
            // (channel_ids = Some(empty) falls here because no IDs to filter
            // by and channel-less events are included.)
        }
        (Some(_), false) | (None, false) => {
            // Caller said "no accessible channels and exclude channel-less" —
            // produces an empty result.
            return Ok(SearchResult {
                hits: Vec::new(),
                page,
            });
        }
    }

    if let Some(ref kinds) = query.kinds {
        if !kinds.is_empty() {
            qb.push(" AND kind = ANY(");
            qb.push_bind(kinds.clone());
            qb.push(")");
        }
    }

    if let Some(ref authors) = query.authors {
        if !authors.is_empty() {
            qb.push(" AND pubkey = ANY(");
            qb.push_bind(authors.clone());
            qb.push(")");
        }
    }

    if let Some(since) = query.since {
        qb.push(" AND created_at >= to_timestamp(");
        qb.push_bind(since);
        qb.push(")");
    }

    if let Some(until) = query.until {
        qb.push(" AND created_at <= to_timestamp(");
        qb.push_bind(until);
        qb.push(")");
    }

    qb.push(" ORDER BY rank DESC, created_at DESC, id LIMIT ");
    qb.push_bind(per_page_actual as i64);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb.build().fetch_all(pool).await?;

    let mut hits = Vec::with_capacity(rows.len());
    for row in rows {
        let id_bytes: Vec<u8> = row.try_get("id")?;
        let pk_bytes: Vec<u8> = row.try_get("pubkey")?;
        let id: [u8; 32] = id_bytes.try_into().map_err(|v: Vec<u8>| {
            sqlx::Error::Decode(format!("event id column is {} bytes, expected 32", v.len()).into())
        })?;
        let pubkey: [u8; 32] = pk_bytes.try_into().map_err(|v: Vec<u8>| {
            sqlx::Error::Decode(format!("pubkey column is {} bytes, expected 32", v.len()).into())
        })?;
        hits.push(SearchHit {
            event_id: id,
            kind: row.try_get("kind")?,
            pubkey,
            channel_id: row.try_get("channel_id")?,
            created_at: row.try_get("created_at_s")?,
            rank: row.try_get("rank")?,
        });
    }

    Ok(SearchResult { hits, page })
}
