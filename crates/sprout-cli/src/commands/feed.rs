use std::cmp::Reverse;

use crate::client::{normalize_events, SproutClient};
use crate::error::CliError;

/// Get activity feed — query events mentioning our pubkey (via p-tag).
pub async fn cmd_get_feed(
    client: &SproutClient,
    since: Option<i64>,
    limit: Option<u32>,
    _types: Option<&str>,
) -> Result<(), CliError> {
    let my_pk = client.keys().public_key().to_hex();
    let limit = limit.unwrap_or(20).min(50);

    let mut filter = serde_json::json!({
        "#p": [my_pk],
        "limit": limit
    });

    if let Some(s) = since {
        filter["since"] = serde_json::json!(s);
    }

    let resp = client.query(&filter).await?;
    let mut events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    events.sort_by_key(|e| Reverse(e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0)));
    println!("{}", normalize_events(&events));
    Ok(())
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn dispatch(cmd: crate::FeedCmd, client: &SproutClient) -> Result<(), CliError> {
    use crate::FeedCmd;
    match cmd {
        FeedCmd::Get {
            since,
            limit,
            types,
        } => cmd_get_feed(client, since, limit, types.as_deref()).await,
    }
}
