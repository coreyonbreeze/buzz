//! S3/MinIO storage client.

use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;

use buzz_core::tenant::{CommunityId, TenantContext};

use crate::config::MediaConfig;
use crate::error::MediaError;
use bytes::Bytes;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::{Deserialize, Serialize};

/// A stream of byte chunks from S3, usable with `axum::body::Body::from_stream()`.
pub type ByteStream = Pin<Box<dyn futures_core::Stream<Item = Result<Bytes, MediaError>> + Send>>;

/// Bare S3 user-metadata key for the authenticated uploader pubkey.
pub const BUZZ_UPLOADER_ID_META_KEY: &str = "buzz-uploader-id";
/// Bare S3 user-metadata key for the uploader's configured display name.
pub const BUZZ_UPLOADER_NAME_META_KEY: &str = "buzz-uploader-name";
/// Bare S3 user-metadata key for the server-resolved community id.
pub const BUZZ_COMMUNITY_ID_META_KEY: &str = "buzz-community-id";
/// Bare S3 user-metadata key for the human-readable community host prefix.
pub const BUZZ_COMMUNITY_ALIAS_META_KEY: &str = "buzz-community-alias";

/// S3-compatible object storage client.
pub struct MediaStorage {
    bucket: Box<Bucket>,
}

impl MediaStorage {
    /// Create a new storage client from config.
    ///
    /// Credential selection:
    /// - If both `s3_access_key` and `s3_secret_key` are non-empty, use them as
    ///   static credentials (MinIO/local/dev, or any static-key deployment).
    /// - Otherwise, fall back to the AWS default credential chain via
    ///   [`Credentials::default`]: environment, shared profile, web-identity
    ///   token (IRSA on EKS — `AssumeRoleWithWebIdentity`), container, and
    ///   instance-metadata providers, in that order. This lets the relay use
    ///   the pod's IAM role without long-lived static keys.
    pub fn new(config: &MediaConfig) -> Result<Self, MediaError> {
        let region = Region::Custom {
            region: config.s3_region.clone(),
            endpoint: config.s3_endpoint.clone(),
        };
        let creds = match (
            config.s3_access_key.is_empty(),
            config.s3_secret_key.is_empty(),
        ) {
            (false, false) => Credentials::new(
                Some(&config.s3_access_key),
                Some(&config.s3_secret_key),
                None,
                None,
                None,
            ),
            (true, true) => {
                // No static keys configured: resolve from the AWS credential chain
                // (IRSA web-identity, env, profile, instance metadata).
                Credentials::default()
            }
            _ => {
                return Err(MediaError::StorageError(
                    "s3_access_key and s3_secret_key must be configured together, or both empty to use the AWS credential chain"
                        .to_string(),
                ));
            }
        }
        .map_err(|e| MediaError::StorageError(e.to_string()))?;
        let bucket = Bucket::new(&config.s3_bucket, region, creds)
            .map_err(|e| MediaError::StorageError(e.to_string()))?
            .with_path_style();
        Ok(Self { bucket })
    }

    /// Store an object from a byte slice.
    ///
    /// Used for images, sidecars, and thumbnails. For large video files use
    /// [`put_file`] to avoid loading the entire blob into RAM.
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), MediaError> {
        self.bucket
            .put_object_with_content_type(key, bytes, content_type)
            .await?;
        Ok(())
    }

    /// Store an object from a byte slice with `x-amz-meta-*` object metadata.
    ///
    /// `metadata` keys are bare names (e.g. `buzz-uploader-id`); the S3 client
    /// adds the `x-amz-meta-` prefix. Used for media blobs that carry upload
    /// attribution so out-of-band consumers can read it from a HEAD without
    /// touching relay internals.
    pub async fn put_with_metadata(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
        metadata: &[(&str, &str)],
    ) -> Result<(), MediaError> {
        let mut builder = self
            .bucket
            .put_object_builder(key, bytes)
            .with_content_type(content_type);
        for (k, v) in metadata {
            builder = builder
                .with_metadata(k, v)
                .map_err(|e| MediaError::StorageError(e.to_string()))?;
        }
        builder.execute().await?;
        Ok(())
    }

    /// Stream a file from disk into S3 without loading it into RAM.
    ///
    /// Uses rust-s3's `put_object_stream_with_content_type` which reads from
    /// the file incrementally via an 8 MiB `BufReader`. The full file is never
    /// held in memory simultaneously. Intended for video blobs (up to 500 MB).
    pub async fn put_file(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<(), MediaError> {
        self.put_file_with_metadata(key, path, content_type, &[])
            .await
    }

    /// Stream a file from disk into S3 with `x-amz-meta-*` object metadata.
    ///
    /// Metadata is attached via bucket-level `extra_headers` (not the stream
    /// builder's `with_metadata`) because rust-s3's streaming multipart path
    /// only forwards builder headers on the small-file (single PUT) branch;
    /// bucket `extra_headers` are applied to `InitiateMultipartUpload` too, so
    /// metadata survives files larger than the 8 MiB chunk threshold.
    pub async fn put_file_with_metadata(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
        metadata: &[(&str, &str)],
    ) -> Result<(), MediaError> {
        const BUF: usize = 8 * 1024 * 1024; // 8 MiB read buffer

        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| MediaError::Io(e.to_string()))?;
        let mut reader = tokio::io::BufReader::with_capacity(BUF, file);

        if metadata.is_empty() {
            self.bucket
                .put_object_stream_with_content_type(&mut reader, key, content_type)
                .await?;
            return Ok(());
        }

        let headers = build_amz_meta_headers(metadata)?;
        let bucket = self
            .bucket
            .with_extra_headers(headers)
            .map_err(|e| MediaError::StorageError(e.to_string()))?;
        bucket
            .put_object_stream_with_content_type(&mut reader, key, content_type)
            .await?;
        Ok(())
    }

    /// Retrieve an object's bytes.
    pub async fn get(&self, key: &str) -> Result<Vec<u8>, MediaError> {
        match self.bucket.get_object(key).await {
            Ok(response) => Ok(response.to_vec()),
            Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Err(MediaError::NotFound),
            Err(e) => Err(MediaError::StorageError(e.to_string())),
        }
    }

    /// Retrieve a byte range from an object via S3-native `Range` GET.
    ///
    /// `start` and `end` are inclusive byte offsets. Only the requested slice
    /// is transferred from S3 — the full object is never loaded into RAM.
    /// Intended for HTTP 206 range responses on large video blobs.
    pub async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>, MediaError> {
        match self.bucket.get_object_range(key, start, Some(end)).await {
            Ok(response) => Ok(response.to_vec()),
            Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Err(MediaError::NotFound),
            Err(e) => Err(MediaError::StorageError(e.to_string())),
        }
    }

    /// Stream an object's bytes from S3 without loading into RAM.
    ///
    /// Returns a pinned stream of `Result<Bytes, MediaError>` chunks.
    /// The full object is never buffered — intended for streaming large
    /// blobs (video) directly into HTTP responses via `Body::from_stream()`.
    pub async fn get_stream(&self, key: &str) -> Result<ByteStream, MediaError> {
        let response = self
            .bucket
            .get_object_stream(key)
            .await
            .map_err(|e| MediaError::StorageError(e.to_string()))?;

        if response.status_code == 404 {
            return Err(MediaError::NotFound);
        }

        let stream = futures_util::StreamExt::map(response.bytes, |chunk| {
            chunk.map_err(|e| MediaError::StorageError(e.to_string()))
        });
        Ok(Box::pin(stream))
    }

    /// Check if an object exists. Returns false on 404.
    pub async fn head(&self, key: &str) -> Result<bool, MediaError> {
        match self.bucket.head_object(key).await {
            Ok(_) => Ok(true),
            Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(false),
            Err(e) => Err(MediaError::StorageError(e.to_string())),
        }
    }

    /// Delete an object. Returns an error on failure — callers decide whether to propagate.
    pub async fn delete(&self, key: &str) -> Result<(), MediaError> {
        self.bucket
            .delete_object(key)
            .await
            .map_err(|e| MediaError::StorageError(e.to_string()))?;
        Ok(())
    }

    /// HEAD with metadata — returns Content-Length (size) and user metadata.
    pub async fn head_with_metadata(&self, key: &str) -> Result<Option<BlobHeadMeta>, MediaError> {
        match self.bucket.head_object(key).await {
            Ok((result, _)) => Ok(Some(BlobHeadMeta::from_head_object_result(result))),
            Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(None),
            Err(e) => Err(MediaError::StorageError(e.to_string())),
        }
    }

    /// Build the community-scoped sidecar key for a given sha256 (bare hash).
    ///
    /// Raw media bytes remain shared content-addressed CAS (`{sha}.{ext}`), but
    /// the metadata sidecar is the tenant read gate. A blob in another
    /// community must never be observable through a global `_meta/{sha}.json`
    /// lookup.
    pub fn sidecar_key(community: CommunityId, sha256: &str) -> String {
        format!("_meta/{community}/{sha256}.json")
    }

    /// Build the community-scoped sidecar key from the resolved request tenant.
    pub fn ctx_sidecar_key(ctx: &TenantContext, sha256: &str) -> String {
        Self::sidecar_key(ctx.community(), sha256)
    }

    /// Read community-scoped sidecar JSON for a given sha256 (bare hash).
    pub async fn get_sidecar(
        &self,
        ctx: &TenantContext,
        sha256: &str,
    ) -> Result<BlobMeta, MediaError> {
        let key = Self::ctx_sidecar_key(ctx, sha256);
        let resp = self.bucket.get_object(&key).await?;
        let meta: BlobMeta = serde_json::from_slice(&resp.to_vec())?;
        Ok(meta)
    }

    /// Write community-scoped sidecar JSON for a given sha256 (bare hash).
    ///
    /// `ctx` must be the server-resolved request tenant. Callers must never
    /// derive the community from client-supplied blob metadata, URLs, or event
    /// tags; this sidecar key is the tenant read gate for otherwise shared CAS
    /// bytes.
    pub async fn put_sidecar(
        &self,
        ctx: &TenantContext,
        sha256: &str,
        meta: &BlobMeta,
    ) -> Result<(), MediaError> {
        let key = Self::ctx_sidecar_key(ctx, sha256);
        let meta_json = serde_json::to_vec(meta)?;
        self.put(&key, &meta_json, "application/json").await
    }

    /// Convenience: read just the MIME type from the community sidecar.
    ///
    /// Returns `None` for both absent sidecars and storage read failures. Public
    /// read handlers intentionally collapse that distinction to 404 so an
    /// A-bound request cannot distinguish a B-only blob from a missing blob.
    pub async fn read_sidecar_mime(&self, ctx: &TenantContext, sha256_ext: &str) -> Option<String> {
        let sha256 = sha256_ext.split('.').next().unwrap_or(sha256_ext);
        self.get_sidecar(ctx, sha256)
            .await
            .ok()
            .map(|m| m.mime_type)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tenant(n: u128) -> TenantContext {
        TenantContext::resolved(
            CommunityId::from_uuid(uuid::Uuid::from_u128(n)),
            "media.example",
        )
    }

    fn storage_config(access: &str, secret: &str) -> crate::config::MediaConfig {
        crate::config::MediaConfig {
            s3_endpoint: "http://localhost:9000".to_string(),
            s3_access_key: access.to_string(),
            s3_secret_key: secret.to_string(),
            s3_bucket: "buzz-media".to_string(),
            s3_region: "us-west-2".to_string(),
            max_image_bytes: 50 * 1024 * 1024,
            max_gif_bytes: 10 * 1024 * 1024,
            max_video_bytes: 524_288_000,
            max_file_bytes: 104_857_600,
            public_base_url: "http://localhost:3000/media".to_string(),
        }
    }

    /// Static keys present: builds a client without touching the AWS
    /// credential chain (no env/metadata access), and the signing region
    /// comes from config rather than a hardcoded "us-east-1".
    #[test]
    fn static_keys_build_client_with_configured_region() {
        let storage = MediaStorage::new(&storage_config("buzz_dev", "buzz_dev_secret"))
            .expect("static creds should build a client");
        match storage.bucket.region {
            Region::Custom { ref region, .. } => assert_eq!(region, "us-west-2"),
            other => panic!("expected Custom region, got {other:?}"),
        }
    }

    #[test]
    fn partial_static_keys_are_rejected() {
        let err = match MediaStorage::new(&storage_config("buzz_dev", "")) {
            Ok(_) => panic!("partial static creds must not silently use credential chain"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("must be configured together"),
            "unexpected error: {err}"
        );

        let err = match MediaStorage::new(&storage_config("", "buzz_dev_secret")) {
            Ok(_) => panic!("partial static creds must not silently use credential chain"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("must be configured together"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn sidecar_keys_are_community_scoped() {
        let a = tenant(1);
        let b = tenant(2);
        let sha = "f".repeat(64);

        assert_eq!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            format!("_meta/{}/{sha}.json", a.community())
        );
        assert_ne!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            MediaStorage::ctx_sidecar_key(&b, &sha)
        );
        assert_ne!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            format!("_meta/{sha}.json")
        );
    }

    /// Mutate-bite shape for the media substrate: same CAS bytes/hash can be
    /// known in A and B, but the sidecar is the read/existence gate. If the
    /// community segment is dropped from `sidecar_key`, B's metadata overwrites
    /// A's in this map and A observes B's MIME (wrong answer, not absence).
    #[test]
    fn same_sha_sidecars_do_not_bleed_between_communities() {
        let a = tenant(1);
        let b = tenant(2);
        let sha = "a".repeat(64);
        let mut sidecars = HashMap::new();

        sidecars.insert(MediaStorage::ctx_sidecar_key(&a, &sha), "image/png");
        sidecars.insert(MediaStorage::ctx_sidecar_key(&b, &sha), "video/mp4");

        assert_eq!(
            sidecars[&MediaStorage::ctx_sidecar_key(&a, &sha)],
            "image/png"
        );
        assert_eq!(
            sidecars[&MediaStorage::ctx_sidecar_key(&b, &sha)],
            "video/mp4"
        );
    }

    #[test]
    fn amz_meta_headers_are_prefixed_and_validated() {
        let headers = build_amz_meta_headers(&[
            (BUZZ_UPLOADER_ID_META_KEY, "aabbcc"),
            (BUZZ_UPLOADER_NAME_META_KEY, "Ada"),
            (BUZZ_COMMUNITY_ID_META_KEY, "0000-1111"),
            (BUZZ_COMMUNITY_ALIAS_META_KEY, "moderation"),
        ])
        .unwrap();
        assert_eq!(
            headers
                .get(format!("x-amz-meta-{BUZZ_UPLOADER_ID_META_KEY}"))
                .unwrap(),
            "aabbcc"
        );
        assert_eq!(
            headers
                .get(format!("x-amz-meta-{BUZZ_UPLOADER_NAME_META_KEY}"))
                .unwrap(),
            "Ada"
        );
        assert_eq!(
            headers
                .get(format!("x-amz-meta-{BUZZ_COMMUNITY_ID_META_KEY}"))
                .unwrap(),
            "0000-1111"
        );
        assert_eq!(
            headers
                .get(format!("x-amz-meta-{BUZZ_COMMUNITY_ALIAS_META_KEY}"))
                .unwrap(),
            "moderation"
        );

        // Control characters in values are rejected, not silently mangled.
        assert!(build_amz_meta_headers(&[(BUZZ_UPLOADER_ID_META_KEY, "bu\nzz")]).is_err());
        // Invalid header-name characters in the key are rejected.
        assert!(build_amz_meta_headers(&[("bad key", "v")]).is_err());
    }

    #[test]
    fn blob_head_meta_surfaces_s3_user_metadata() {
        let mut metadata = HashMap::new();
        metadata.insert(BUZZ_UPLOADER_ID_META_KEY.to_string(), "aabbcc".to_string());
        metadata.insert(BUZZ_UPLOADER_NAME_META_KEY.to_string(), "Ada".to_string());
        metadata.insert(
            BUZZ_COMMUNITY_ID_META_KEY.to_string(),
            "0000-1111".to_string(),
        );
        metadata.insert(
            BUZZ_COMMUNITY_ALIAS_META_KEY.to_string(),
            "moderation".to_string(),
        );

        let result = s3::serde_types::HeadObjectResult {
            content_length: Some(42),
            metadata: Some(metadata),
            ..Default::default()
        };

        let head = BlobHeadMeta::from_head_object_result(result);
        assert_eq!(head.size, 42);
        assert_eq!(
            head.metadata.get(BUZZ_UPLOADER_ID_META_KEY),
            Some(&"aabbcc".to_string())
        );
        assert_eq!(
            head.metadata.get(BUZZ_UPLOADER_NAME_META_KEY),
            Some(&"Ada".to_string())
        );
        assert_eq!(
            head.metadata.get(BUZZ_COMMUNITY_ID_META_KEY),
            Some(&"0000-1111".to_string())
        );
        assert_eq!(
            head.metadata.get(BUZZ_COMMUNITY_ALIAS_META_KEY),
            Some(&"moderation".to_string())
        );
    }

    /// Old sidecars (written before upload attribution) must still parse, and
    /// new fields must round-trip.
    #[test]
    fn sidecar_attribution_fields_are_backward_compatible() {
        // Pre-attribution sidecar JSON — no uploader_id/community_id keys.
        let old = r#"{"dim":"800x600","blurhash":"","thumb_url":"","ext":"jpg","mime_type":"image/jpeg","size":123,"uploaded_at":1700000000}"#;
        let meta: BlobMeta = serde_json::from_str(old).unwrap();
        assert_eq!(meta.uploader_id, None);
        assert_eq!(meta.uploader_name, None);
        assert_eq!(meta.community_id, None);
        assert_eq!(meta.community_alias, None);

        // Absent attribution is omitted from serialized output (not null).
        let json = serde_json::to_value(&meta).unwrap();
        assert!(json.get("uploader_id").is_none());
        assert!(json.get("uploader_name").is_none());
        assert!(json.get("community_id").is_none());
        assert!(json.get("community_alias").is_none());

        // Populated attribution round-trips.
        let meta = BlobMeta {
            uploader_id: Some("aa".repeat(32)),
            uploader_name: Some("Ada".to_string()),
            community_id: Some("6b8e1c2a-0000-0000-0000-000000000000".to_string()),
            community_alias: Some("moderation".to_string()),
            ..meta
        };
        let round: BlobMeta = serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        assert_eq!(round.uploader_id, meta.uploader_id);
        assert_eq!(round.uploader_name, meta.uploader_name);
        assert_eq!(round.community_id, meta.community_id);
        assert_eq!(round.community_alias, meta.community_alias);
    }
}

/// Build an `x-amz-meta-*` [`http::HeaderMap`] from bare metadata key/value
/// pairs. Keys must be valid header-name characters; values must be valid
/// header values (S3 object metadata is US-ASCII).
fn build_amz_meta_headers(metadata: &[(&str, &str)]) -> Result<http::HeaderMap, MediaError> {
    let mut headers = http::HeaderMap::new();
    for (k, v) in metadata {
        let name: http::HeaderName = format!("x-amz-meta-{k}")
            .parse()
            .map_err(|_| MediaError::StorageError(format!("invalid metadata key: {k}")))?;
        let value: http::HeaderValue = v
            .parse()
            .map_err(|_| MediaError::StorageError(format!("invalid metadata value for {k}")))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

/// Metadata returned by HEAD for BUD-01 responses and moderation tooling.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlobHeadMeta {
    /// Object size in bytes.
    pub size: u64,
    /// S3 user metadata returned by HEAD, keyed by bare metadata name (without
    /// the `x-amz-meta-` prefix), e.g. `buzz-uploader-id`.
    pub metadata: HashMap<String, String>,
}

impl BlobHeadMeta {
    fn from_head_object_result(result: s3::serde_types::HeadObjectResult) -> Self {
        Self {
            size: result.content_length.unwrap_or(0).max(0) as u64,
            metadata: result.metadata.unwrap_or_default(),
        }
    }
}

/// Full blob metadata — stored as sidecar JSON in `_meta/{community}/{sha256}.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlobMeta {
    /// Pixel dimensions ("WxH").
    pub dim: String,
    /// Blurhash string.
    pub blurhash: String,
    /// Full URL to thumbnail.
    pub thumb_url: String,
    /// File extension (e.g. "jpg").
    pub ext: String,
    /// MIME type (e.g. "image/jpeg").
    pub mime_type: String,
    /// File size in bytes.
    pub size: u64,
    /// Unix timestamp when the blob was first uploaded.
    #[serde(default)]
    pub uploaded_at: i64,
    /// Video duration in seconds. `None` for non-video blobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// Authenticated uploader pubkey (hex). Upload attribution for
    /// out-of-band consumers; `None` on sidecars written before attribution
    /// existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploader_id: Option<String>,
    /// Best-effort configured display name for the authenticated uploader. This
    /// is a readability hint, not an authority boundary; `uploader_id` and the
    /// audit log remain authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploader_name: Option<String>,
    /// Host-resolved community id (UUID string). Mirrors the community segment
    /// of the sidecar key so attribution survives even if the object is copied
    /// out of its keyed location; `None` on pre-attribution sidecars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_id: Option<String>,
    /// Human-readable community alias derived from the server-resolved host's
    /// first label (for example `team` from `team.example.com`). Readability
    /// hint only; `community_id` remains authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community_alias: Option<String>,
}
