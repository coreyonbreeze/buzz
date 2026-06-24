//! Search query building and result parsing.

use serde::Deserialize;
use tracing::debug;

use crate::error::SearchError;

/// Sentinel channel identifier used for events that are not scoped to any
/// channel. Mirrored verbatim from `crates/buzz-search/src/index.rs` so the
/// query layer can pass it through without depending on the indexer.
pub const GLOBAL_CHANNEL_SENTINEL: &str = "__global__";

/// Backend-neutral search query.
///
/// Constructed by `req.rs` from a NIP-50 filter and passed to whichever
/// [`crate::SearchService`] backend is active. Each backend renders these
/// structured fields into its own filter syntax (Typesense `filter_by` string,
/// Postgres `WHERE` clause, …) so the call site doesn't have to know which
/// backend is in use.
///
/// # Access-control invariant
///
/// `channel_ids` is required to be non-empty by construction: external code
/// can only build a `SearchQuery` through [`SearchQuery::new`], which rejects
/// an empty scope with [`SearchError::EmptyChannelScope`]. The fields are
/// `pub(crate)` so backends inside this crate can read them directly, but
/// struct-literal construction from outside the crate is impossible. This
/// keeps "search cannot widen visibility" true at the type level instead of
/// relying on every caller to remember to pass a channel filter.
#[derive(Debug, Clone)]
pub struct SearchQuery {
    /// The full-text query string. Empty string is treated as "match all".
    pub(crate) q: String,
    /// Nostr kinds to restrict to. Empty = no restriction.
    pub(crate) kinds: Vec<u16>,
    /// Event author pubkeys (hex). Empty = no restriction.
    pub(crate) authors: Vec<String>,
    /// Channel UUID strings to restrict to. Never empty — the access-control
    /// boundary. The [`GLOBAL_CHANNEL_SENTINEL`] value (`"__global__"`)
    /// selects events that have no `channel_id` set.
    pub(crate) channel_ids: Vec<String>,
    /// Lower bound on `created_at` (Unix seconds, inclusive).
    pub(crate) since: Option<i64>,
    /// Upper bound on `created_at` (Unix seconds, inclusive).
    pub(crate) until: Option<i64>,
    /// Page number (1-indexed).
    pub(crate) page: u32,
    /// Number of results per page.
    pub(crate) per_page: u32,
}

impl SearchQuery {
    /// Build a `SearchQuery` with the required full-text term and channel
    /// scope. Returns [`SearchError::EmptyChannelScope`] if `channel_ids` is
    /// empty — see the type-level note on the access-control invariant.
    ///
    /// Optional facets (`kinds`, `authors`, `since`, `until`, `page`,
    /// `per_page`) default to "no restriction" / page 1 of 20 results, and
    /// can be set with the `with_*` builder methods.
    pub fn new(q: impl Into<String>, channel_ids: Vec<String>) -> Result<Self, SearchError> {
        if channel_ids.is_empty() {
            return Err(SearchError::EmptyChannelScope);
        }
        Ok(Self {
            q: q.into(),
            kinds: Vec::new(),
            authors: Vec::new(),
            channel_ids,
            since: None,
            until: None,
            page: 1,
            per_page: 20,
        })
    }

    /// Restrict to the given Nostr kinds.
    #[must_use]
    pub fn with_kinds(mut self, kinds: Vec<u16>) -> Self {
        self.kinds = kinds;
        self
    }

    /// Restrict to the given author pubkeys (hex).
    #[must_use]
    pub fn with_authors(mut self, authors: Vec<String>) -> Self {
        self.authors = authors;
        self
    }

    /// Set the lower bound on `created_at` (Unix seconds, inclusive).
    #[must_use]
    pub fn with_since(mut self, since: Option<i64>) -> Self {
        self.since = since;
        self
    }

    /// Set the upper bound on `created_at` (Unix seconds, inclusive).
    #[must_use]
    pub fn with_until(mut self, until: Option<i64>) -> Self {
        self.until = until;
        self
    }

    /// Set the 1-indexed page number.
    #[must_use]
    pub fn with_page(mut self, page: u32) -> Self {
        self.page = page;
        self
    }

    /// Set the page size.
    #[must_use]
    pub fn with_per_page(mut self, per_page: u32) -> Self {
        self.per_page = per_page;
        self
    }
}

impl SearchQuery {
    /// Renders the structured filters into a Typesense `filter_by` string.
    /// Returns `None` when no constraints apply.
    pub(crate) fn typesense_filter_by(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();

        if !self.channel_ids.is_empty() {
            // Split global sentinel from real UUIDs so we emit
            //   (channel_id:=[uuid1,uuid2] || channel_id:=__global__)
            // instead of an invalid `channel_id:=[__global__,uuid]` mix.
            let (globals, uuids): (Vec<&String>, Vec<&String>) = self
                .channel_ids
                .iter()
                .partition(|id| id.as_str() == GLOBAL_CHANNEL_SENTINEL);

            let include_global = !globals.is_empty();
            if !uuids.is_empty() {
                let joined: Vec<String> = uuids.iter().map(|s| (*s).clone()).collect();
                if include_global {
                    parts.push(format!(
                        "(channel_id:=[{}] || channel_id:=__global__)",
                        joined.join(",")
                    ));
                } else {
                    parts.push(format!("channel_id:=[{}]", joined.join(",")));
                }
            } else if include_global {
                parts.push("channel_id:=__global__".to_string());
            }
        }

        if !self.kinds.is_empty() {
            let vs: Vec<String> = self.kinds.iter().map(|k| k.to_string()).collect();
            parts.push(format!("kind:=[{}]", vs.join(",")));
        }
        if !self.authors.is_empty() {
            parts.push(format!("pubkey:=[{}]", self.authors.join(",")));
        }
        if let Some(since) = self.since {
            parts.push(format!("created_at:>={}", since));
        }
        if let Some(until) = self.until {
            parts.push(format!("created_at:<={}", until));
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" && "))
        }
    }

    /// Renders the Typesense HTTP query parameters. Kept for compatibility
    /// with `to_query_params`-based callers; the actual production path uses
    /// `multi_search` via [`search`].
    pub fn to_query_params(&self) -> Vec<(String, String)> {
        let mut params = vec![
            ("q".into(), self.q.clone()),
            ("query_by".into(), "content".into()),
            ("page".into(), self.page.to_string()),
            ("per_page".into(), self.per_page.to_string()),
        ];

        if let Some(filter) = self.typesense_filter_by() {
            params.push(("filter_by".into(), filter));
        }

        params
    }
}

/// A single search result hit.
#[derive(Debug, Clone)]
pub struct SearchHit {
    /// Hex event ID of the matching event.
    pub event_id: String,
    /// Event content text **as indexed in Typesense** — not necessarily the
    /// canonical event content.
    ///
    /// For kind:0 (user metadata) events, `flatten_kind0_for_indexing` in
    /// `index.rs` appends the parsed `display_name` / `name` / `nip05` values
    /// to the original JSON content (space-separated) so the default
    /// tokenizer can produce clean word tokens. That doctored string is what
    /// lands here.
    ///
    /// All production read paths (`bridge.rs::handle_bridge_search`,
    /// `handlers/req.rs` WS REQ) refetch the canonical `StoredEvent` from
    /// Postgres by `event_id` and ignore this field — which is why the
    /// append-to-content trick is safe. If you're adding a new feature that
    /// reads this field directly, do the same: fetch the canonical event by
    /// id rather than trusting `content` to round-trip.
    pub content: String,
    /// Nostr kind number.
    pub kind: u16,
    /// Hex public key of the event author.
    pub pubkey: String,
    /// Channel UUID string, if the event is scoped to a channel.
    pub channel_id: Option<String>,
    /// Unix timestamp of event creation.
    pub created_at: i64,
    /// Typesense relevance score.
    pub score: f64,
}

/// The result of a search query.
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Matching hits for this page.
    pub hits: Vec<SearchHit>,
    /// Total number of matching documents across all pages.
    pub found: u64,
    /// Current page number.
    pub page: u32,
}

#[derive(Debug, Deserialize)]
struct TypesenseMultiSearchResponse {
    results: Vec<TypesenseSearchResult>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TypesenseSearchResult {
    Ok(TypesenseSearchResponse),
    Error(TypesenseSearchError),
}

#[derive(Debug, Deserialize)]
struct TypesenseSearchError {
    code: u16,
    error: String,
}

#[derive(Debug, Deserialize)]
struct TypesenseSearchResponse {
    found: u64,
    page: u32,
    hits: Vec<TypesenseHit>,
}

#[derive(Debug, Deserialize)]
struct TypesenseHit {
    document: TypesenseDocument,
    #[serde(rename = "text_match")]
    text_match: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TypesenseDocument {
    id: String,
    content: String,
    kind: i32,
    pubkey: String,
    channel_id: Option<String>,
    created_at: i64,
}

/// Executes a search query against Typesense and returns parsed results.
pub async fn search(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    collection_name: &str,
    query: &SearchQuery,
) -> Result<SearchResult, SearchError> {
    debug!(
        q = %query.q,
        page = query.page,
        per_page = query.per_page,
        collection = collection_name,
        "Executing search"
    );

    // Typesense GET search has a 4000-char query string limit. When filter_by
    // contains hundreds of channel UUIDs, the URL exceeds this. Use the
    // /multi_search POST endpoint which accepts the same params in a JSON body.
    let url = format!("{}/multi_search", base_url);
    let mut search_params = serde_json::json!({
        "collection": collection_name,
        "q": query.q,
        "query_by": "content",
        "page": query.page,
        "per_page": query.per_page,
    });
    if let Some(filter) = query.typesense_filter_by() {
        search_params["filter_by"] = serde_json::Value::String(filter);
    }
    let body = serde_json::json!({ "searches": [search_params] });

    let resp = client
        .post(&url)
        .header("X-TYPESENSE-API-KEY", api_key)
        .json(&body)
        .send()
        .await?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        return Err(SearchError::Api { status, body });
    }

    // multi_search wraps results: {"results": [<search_response>]}. Individual
    // searches can fail inside an HTTP 200 response as `{code, error}`; surface
    // those as API errors instead of deserializing them as JSON errors so callers
    // and logs show the actual Typesense failure.
    let wrapper: TypesenseMultiSearchResponse = resp.json().await?;
    let ts_resp = wrapper.results.into_iter().next().ok_or(SearchError::Api {
        status: 200,
        body: "empty multi_search results".into(),
    })?;
    match ts_resp {
        TypesenseSearchResult::Ok(response) => parse_response(response),
        TypesenseSearchResult::Error(error) => Err(SearchError::Api {
            status: error.code,
            body: error.error,
        }),
    }
}

fn parse_response(ts_resp: TypesenseSearchResponse) -> Result<SearchResult, SearchError> {
    let hits = ts_resp
        .hits
        .into_iter()
        .map(|hit| {
            // Raw Typesense text_match relevance score (not normalized).
            let score = hit.text_match.unwrap_or(0) as f64;
            SearchHit {
                event_id: hit.document.id,
                content: hit.document.content,
                kind: u16::try_from(hit.document.kind).unwrap_or(0),
                pubkey: hit.document.pubkey,
                channel_id: hit.document.channel_id.filter(|id| id != "__global__"),
                created_at: hit.document.created_at,
                score,
            }
        })
        .collect();

    Ok(SearchResult {
        hits,
        found: ts_resp.found,
        page: ts_resp.page,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A non-empty channel scope used by tests that don't otherwise care
    /// about which channel is being searched — the constructor requires
    /// non-empty `channel_ids`, so tests pick a canonical placeholder.
    const TEST_CHANNEL: &str = "11111111-1111-1111-1111-111111111111";

    fn test_scope() -> Vec<String> {
        vec![TEST_CHANNEL.to_string()]
    }

    #[test]
    fn test_search_query_rejects_empty_channel_scope() {
        // The access-control invariant: empty channel_ids must be refused
        // at construction time, not silently accepted and then patched up
        // by remembering to pass a filter at the call site.
        let err = SearchQuery::new("hello", Vec::new()).expect_err("must reject empty scope");
        assert!(matches!(err, SearchError::EmptyChannelScope));
    }

    #[test]
    fn test_search_query_building() {
        let q = SearchQuery::new("hello world", test_scope())
            .expect("non-empty scope")
            .with_kinds(vec![1])
            .with_page(2)
            .with_per_page(10);

        let params = q.to_query_params();
        let get = |key: &str| -> Option<String> {
            params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };

        assert_eq!(get("q").unwrap(), "hello world");
        assert_eq!(get("query_by").unwrap(), "content");
        assert_eq!(get("page").unwrap(), "2");
        assert_eq!(get("per_page").unwrap(), "10");
        let filter = get("filter_by").unwrap();
        assert!(filter.contains(&format!("channel_id:=[{TEST_CHANNEL}]")));
        assert!(filter.contains("kind:=[1]"));
        // sort_by is no longer emitted — Typesense default = relevance.
        assert!(params.iter().all(|(k, _)| k != "sort_by"));
    }

    #[test]
    fn test_search_query_minimum_filters() {
        // Even with no optional facets, channel scope is always rendered —
        // the access boundary follows the query through every backend path.
        let q = SearchQuery::new("*", test_scope()).expect("non-empty scope");

        let params = q.to_query_params();
        let has_key = |key: &str| params.iter().any(|(k, _)| k == key);

        assert!(has_key("q"));
        assert!(has_key("query_by"));
        assert!(has_key("page"));
        assert!(has_key("per_page"));
        assert!(has_key("filter_by"));
        assert!(!has_key("sort_by"));

        let get = |key: &str| -> Option<String> {
            params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            get("filter_by").unwrap(),
            format!("channel_id:=[{TEST_CHANNEL}]")
        );
    }

    #[test]
    fn test_typesense_filter_by_renders_structured_fields() {
        let q = SearchQuery::new("hello", test_scope())
            .expect("non-empty scope")
            .with_kinds(vec![1, 42])
            .with_authors(vec!["deadbeef".into()])
            .with_since(Some(1_700_000_000))
            .with_until(Some(1_700_000_100));
        let filter = q.typesense_filter_by().expect("non-empty filter");
        assert!(filter.contains(&format!("channel_id:=[{TEST_CHANNEL}]")));
        assert!(filter.contains("kind:=[1,42]"));
        assert!(filter.contains("pubkey:=[deadbeef]"));
        assert!(filter.contains("created_at:>=1700000000"));
        assert!(filter.contains("created_at:<=1700000100"));
    }

    #[test]
    fn test_typesense_filter_by_handles_global_sentinel() {
        let with_global_only = SearchQuery::new("*", vec![GLOBAL_CHANNEL_SENTINEL.to_string()])
            .expect("non-empty scope");
        assert_eq!(
            with_global_only.typesense_filter_by().as_deref(),
            Some("channel_id:=__global__")
        );

        let with_mix = SearchQuery::new(
            "*",
            vec![
                TEST_CHANNEL.to_string(),
                GLOBAL_CHANNEL_SENTINEL.to_string(),
            ],
        )
        .expect("non-empty scope");
        let filter = with_mix.typesense_filter_by().expect("non-empty");
        assert!(filter.contains("|| channel_id:=__global__"));
        assert!(filter.contains(&format!("channel_id:=[{TEST_CHANNEL}]")));
    }

    #[test]
    fn test_search_result_parsing() {
        let raw = json!({
            "found": 42,
            "page": 1,
            "hits": [
                {
                    "document": {
                        "id": "abc123",
                        "content": "hello buzz",
                        "kind": 1,
                        "pubkey": "deadbeef",
                        "channel_id": "chan-uuid",
                        "created_at": 1700000000i64,
                        "tags_flat": ["e:ref123"]
                    },
                    "text_match": 578730123i64
                },
                {
                    "document": {
                        "id": "def456",
                        "content": "another message",
                        "kind": 42,
                        "pubkey": "cafebabe",
                        "channel_id": null,
                        "created_at": 1700000100i64,
                        "tags_flat": []
                    },
                    "text_match": null
                }
            ]
        });

        let ts_resp: TypesenseSearchResponse = serde_json::from_value(raw).expect("should parse");
        let result = parse_response(ts_resp).expect("should succeed");

        assert_eq!(result.found, 42);
        assert_eq!(result.page, 1);
        assert_eq!(result.hits.len(), 2);

        let h0 = &result.hits[0];
        assert_eq!(h0.event_id, "abc123");
        assert_eq!(h0.content, "hello buzz");
        assert_eq!(h0.kind, 1);
        assert_eq!(h0.pubkey, "deadbeef");
        assert_eq!(h0.channel_id.as_deref(), Some("chan-uuid"));
        assert_eq!(h0.created_at, 1700000000);
        assert!(h0.score > 0.0);

        let h1 = &result.hits[1];
        assert_eq!(h1.event_id, "def456");
        assert_eq!(h1.kind, 42);
        assert!(h1.channel_id.is_none());
        assert_eq!(h1.score, 0.0); // null text_match → 0
    }

    #[test]
    fn test_search_result_empty() {
        let raw = json!({
            "found": 0,
            "page": 1,
            "hits": []
        });

        let ts_resp: TypesenseSearchResponse = serde_json::from_value(raw).expect("should parse");
        let result = parse_response(ts_resp).expect("should succeed");

        assert_eq!(result.found, 0);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn test_multi_search_result_success_parses() {
        let raw = json!({
            "results": [{
                "found": 1,
                "page": 1,
                "hits": [{
                    "document": {
                        "id": "abc123",
                        "content": "hello buzz",
                        "kind": 1,
                        "pubkey": "deadbeef",
                        "channel_id": "chan-uuid",
                        "created_at": 1700000000i64,
                        "tags_flat": []
                    },
                    "text_match": 578730123i64
                }]
            }]
        });

        let wrapper: TypesenseMultiSearchResponse =
            serde_json::from_value(raw).expect("should parse multi_search success result");
        let response = match wrapper.results.into_iter().next().expect("one result") {
            TypesenseSearchResult::Ok(response) => response,
            TypesenseSearchResult::Error(err) => panic!("expected success result, got {err:?}"),
        };

        let result = parse_response(response).expect("should parse response");
        assert_eq!(result.found, 1);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].event_id, "abc123");
    }

    #[test]
    fn test_multi_search_result_error_parses() {
        let raw = json!({
            "results": [{
                "code": 400,
                "error": "Could not find a filter field named `channel_id` in the schema."
            }]
        });

        let wrapper: TypesenseMultiSearchResponse =
            serde_json::from_value(raw).expect("should parse multi_search error result");
        let err = match wrapper.results.into_iter().next().expect("one result") {
            TypesenseSearchResult::Ok(_) => panic!("expected error result"),
            TypesenseSearchResult::Error(err) => err,
        };

        assert_eq!(err.code, 400);
        assert!(err.error.contains("channel_id"));
    }
}
