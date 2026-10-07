use crate::error::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_BODY: usize = 24 * 1024 * 1024;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_TOTAL: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub dpr: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Element {
    pub tag: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    #[serde(default)]
    pub number: Option<u32>,
    pub kind: String,
    #[serde(default)]
    pub rect: Option<Rect>,
    #[serde(default)]
    pub points: Vec<Point>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub element: Option<Element>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub mime: String,
    pub data_base64: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub annotation_id: String,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub capture: Option<CropCapture>,
    pub mime: String,
    pub data_base64: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CropCapture {
    pub captured_at: String,
    pub viewport: Viewport,
    /// Padded/clipped source image boundary, in the ORIGINAL viewport CSS pixels.
    pub rect: Rect,
    /// Full annotation geometry when this crop was captured, not today's position.
    pub annotation_rect: Rect,
    #[serde(default)]
    pub points: Vec<Point>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub client_id: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub message: String,
    pub viewport: Viewport,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    pub screenshot: Image,
    #[serde(default)]
    pub annotated_screenshot: Option<Image>,
    #[serde(default)]
    pub crops: Vec<Crop>,
}
pub struct Validated {
    pub screenshot: Vec<u8>,
    pub screenshot_dimensions: (u32, u32),
    pub annotated_screenshot: Option<Vec<u8>>,
    pub crops: Vec<ValidatedCrop>,
}
pub struct ValidatedCrop {
    pub annotation_id: String,
    pub number: u32,
    pub bytes: Vec<u8>,
    pub dimensions: (u32, u32),
}
impl Validated {
    pub fn bytes_total(&self) -> usize {
        self.screenshot.len()
            + self.annotated_screenshot.as_ref().map_or(0, Vec::len)
            + self.crops.iter().map(|c| c.bytes.len()).sum::<usize>()
    }
}
fn bad(detail: &str) -> AppError {
    AppError::BadRequest(detail.into())
}

pub fn safe_text(value: &str, max: usize) -> bool {
    value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
pub fn origin(raw: &str) -> Result<String, AppError> {
    if !safe_text(raw, 4096) {
        return Err(bad("website URL is too long or contains controls"));
    }
    let url = url::Url::parse(raw).map_err(|_| bad("invalid website URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(bad(
            "website must use http or https without embedded credentials",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn valid_viewport(v: &Viewport) -> bool {
    [v.width, v.height, v.dpr, v.scroll_x, v.scroll_y]
        .iter()
        .all(|n| n.is_finite())
        && (1.0..=8192.0).contains(&v.width)
        && (1.0..=8192.0).contains(&v.height)
        && (0.1..=8.0).contains(&v.dpr)
        && v.scroll_x.abs() <= 1e9
        && v.scroll_y.abs() <= 1e9
}
fn bounded_rect(r: &Rect) -> bool {
    [r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height]
        .iter()
        .all(|n| n.is_finite() && n.abs() <= 1e7)
        && r.width > 0.0
        && r.height > 0.0
}
fn image_matches_rect((width, height): (u32, u32), r: &Rect, dpr: f64) -> bool {
    width as f64 <= r.width * dpr + 2.0
        && height as f64 <= r.height * dpr + 2.0
        // Both axes are rounded independently when the browser crops and
        // downsamples. Comparing only inferred height rejects tall, narrow
        // crops even when each axis differs by less than one raster pixel.
        && (width as f64 * r.height - height as f64 * r.width).abs()
            <= 2.0 * (r.width + r.height)
}

impl Payload {
    pub fn validate(&self, bound_origin: &str) -> Result<Validated, AppError> {
        if self.client_id.is_empty()
            || self.client_id.len() > 96
            || !self
                .client_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err(bad("invalid client_id"));
        }
        if !safe_text(&self.url, 4096) || origin(&self.url)? != bound_origin {
            return Err(bad("feedback URL must match the paired website origin"));
        }
        if (!self.message.trim().is_empty() && !safe_text(&self.message, 48_000))
            || self.message.chars().count() > 12_000
            || !safe_text(&self.title, 2048)
            || (self.message.trim().is_empty()
                && !self
                    .annotations
                    .iter()
                    .any(|a| a.text.as_ref().is_some_and(|t| !t.trim().is_empty())))
        {
            return Err(bad(
                "feedback message/title is empty, too long, or contains control characters",
            ));
        }
        let v = &self.viewport;
        if !valid_viewport(v) {
            return Err(bad("invalid viewport"));
        }
        if self.annotations.len() > 40 || self.crops.len() > 40 {
            return Err(bad("at most 40 annotations and crops are allowed"));
        }
        let inside = |x: f64, y: f64| {
            x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 && x <= v.width && y <= v.height
        };
        let mut ids = HashSet::new();
        for (index, a) in self.annotations.iter().enumerate() {
            if a.number.is_some_and(|number| number != index as u32 + 1) {
                return Err(bad("annotation number must match its one-based position"));
            }
            let cropped = self.crops.iter().any(|c| c.annotation_id == a.id);
            let valid_point = |x: f64, y: f64| {
                inside(x, y)
                    || (cropped
                        && x.is_finite()
                        && y.is_finite()
                        && x.abs() <= 1e7
                        && y.abs() <= 1e7)
            };
            if a.id.is_empty()
                || a.id.len() > 64
                || !a
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                || !ids.insert(a.id.as_str())
            {
                return Err(bad("annotation ids must be short, safe, and unique"));
            }
            if !matches!(a.kind.as_str(), "element" | "region" | "draw" | "note")
                || a.points.len() > 1500
                || !a.points.iter().all(|p| valid_point(p.x, p.y))
                || a.text
                    .as_ref()
                    .is_some_and(|t| !safe_text(t, 16_000) || t.chars().count() > 4000)
            {
                return Err(bad("invalid annotation"));
            }
            if let Some(r) = &a.rect {
                if !valid_point(r.x, r.y)
                    || !r.width.is_finite()
                    || !r.height.is_finite()
                    || r.width <= 0.0
                    || r.height <= 0.0
                    || r.width > 1e7
                    || r.height > 1e7
                    || !valid_point(r.x + r.width, r.y + r.height)
                {
                    return Err(bad(
                        "annotation rectangle is outside the screenshot viewport",
                    ));
                }
            }
            if (matches!(a.kind.as_str(), "element" | "region") && a.rect.is_none())
                || (a.kind == "draw" && a.points.len() < 2)
            {
                return Err(bad("annotation geometry is missing"));
            }
            if let Some(e) = &a.element {
                if !safe_text(&e.tag, 64)
                    || [&e.selector, &e.text, &e.role]
                        .iter()
                        .any(|s| s.as_ref().is_some_and(|t| !safe_text(t, 2048)))
                {
                    return Err(bad("element context is too long or contains controls"));
                }
            }
        }
        let screenshot = decode(
            &self.screenshot.mime,
            &self.screenshot.data_base64,
            MAX_IMAGE,
        )?;
        let (width, height) = png_dimensions(&screenshot)?;
        if width as f64 > v.width * v.dpr + 2.0
            || height as f64 > v.height * v.dpr + 2.0
            || (height as f64 - width as f64 * v.height / v.width).abs() > 2.0
        {
            return Err(bad(
                "screenshot must preserve the viewport aspect ratio and may only be downsampled",
            ));
        }
        let annotated_screenshot = match &self.annotated_screenshot {
            Some(image) => {
                let bytes = decode(&image.mime, &image.data_base64, MAX_IMAGE)?;
                if png_dimensions(&bytes)? != (width, height) {
                    return Err(bad(
                        "annotated overview must match the clean screenshot dimensions",
                    ));
                }
                Some(bytes)
            }
            None => None,
        };
        let mut crops = Vec::new();
        let mut crop_ids = HashSet::new();
        let mut total = screenshot.len() + annotated_screenshot.as_ref().map_or(0, Vec::len);
        for c in &self.crops {
            if !ids.contains(c.annotation_id.as_str()) || !crop_ids.insert(c.annotation_id.as_str())
            {
                return Err(bad("crop must reference a unique annotation"));
            }
            let number = self
                .annotations
                .iter()
                .position(|a| a.id == c.annotation_id)
                .unwrap() as u32
                + 1;
            if c.number.is_some_and(|supplied| supplied != number) {
                return Err(bad("crop number must match its annotation number"));
            }
            let bytes = decode(&c.mime, &c.data_base64, 2 * 1024 * 1024)?;
            let dimensions = png_dimensions(&bytes)?;
            if let Some(capture) = &c.capture {
                let source = &capture.rect;
                let annotation = &capture.annotation_rect;
                if !safe_text(&capture.captured_at, 64)
                    || chrono::DateTime::parse_from_rfc3339(&capture.captured_at).is_err()
                    || !valid_viewport(&capture.viewport)
                    || !bounded_rect(source)
                    || !bounded_rect(annotation)
                    || source.x < 0.0
                    || source.y < 0.0
                    || source.x + source.width > capture.viewport.width + 0.01
                    || source.y + source.height > capture.viewport.height + 0.01
                    || source.x >= annotation.x + annotation.width
                    || source.y >= annotation.y + annotation.height
                    || source.x + source.width <= annotation.x
                    || source.y + source.height <= annotation.y
                    || capture.points.len() > 1500
                    || capture.points.iter().any(|p| {
                        !p.x.is_finite()
                            || !p.y.is_finite()
                            || p.x.abs() > 1e7
                            || p.y.abs() > 1e7
                            || p.x < annotation.x - 2.0
                            || p.y < annotation.y - 2.0
                            || p.x > annotation.x + annotation.width + 2.0
                            || p.y > annotation.y + annotation.height + 2.0
                    })
                    || !image_matches_rect(dimensions, source, capture.viewport.dpr)
                {
                    return Err(bad(
                        "crop capture geometry, timestamp, or image dimensions are invalid",
                    ));
                }
            }
            total += bytes.len();
            if total > MAX_TOTAL {
                return Err(bad("feedback images exceed 16 MiB"));
            }
            crops.push(ValidatedCrop {
                annotation_id: c.annotation_id.clone(),
                number,
                bytes,
                dimensions,
            });
        }
        if total > MAX_TOTAL {
            return Err(bad("feedback images exceed 16 MiB"));
        }
        Ok(Validated {
            screenshot,
            screenshot_dimensions: (width, height),
            annotated_screenshot,
            crops,
        })
    }
}
fn decode(mime: &str, raw: &str, limit: usize) -> Result<Vec<u8>, AppError> {
    if mime != "image/png" || raw.len() > limit.div_ceil(3) * 4 {
        return Err(bad("only bounded PNG images are accepted"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| bad("invalid image base64"))?;
    if bytes.len() > limit {
        return Err(bad("image is too large"));
    }
    Ok(bytes)
}

/// Validate the PNG container, IHDR format, bounded dimensions, chunk CRCs,
/// IDAT presence, and terminal IEND. No image decoder is added to the server.
pub fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), AppError> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(bad("invalid PNG signature"));
    }
    let mut offset = 8usize;
    let mut dimensions = None;
    let mut idat = false;
    while offset + 12 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(len))
            .ok_or_else(|| bad("invalid PNG chunk"))?;
        if end > bytes.len() {
            return Err(bad("truncated PNG"));
        }
        let kind = &bytes[offset + 4..offset + 8];
        let data = &bytes[offset + 8..end - 4];
        let expected = u32::from_be_bytes(bytes[end - 4..end].try_into().unwrap());
        let mut crc = !0u32;
        for b in &bytes[offset + 4..end - 4] {
            crc ^= *b as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320u32 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        if !crc != expected {
            return Err(bad("invalid PNG checksum"));
        }
        match kind {
            b"IHDR" if offset == 8 && len == 13 => {
                let w = u32::from_be_bytes(data[..4].try_into().unwrap());
                let h = u32::from_be_bytes(data[4..8].try_into().unwrap());
                if w == 0
                    || h == 0
                    || w > 16384
                    || h > 16384
                    || u64::from(w) * u64::from(h) > 64_000_000
                    || !matches!(
                        (data[9], data[8]),
                        (0, 1 | 2 | 4 | 8 | 16)
                            | (2, 8 | 16)
                            | (3, 1 | 2 | 4 | 8)
                            | (4, 8 | 16)
                            | (6, 8 | 16)
                    )
                    || data[10] != 0
                    || data[11] != 0
                    || data[12] > 1
                {
                    return Err(bad("invalid PNG header or excessive image dimensions"));
                }
                dimensions = Some((w, h));
            }
            b"IHDR" => return Err(bad("duplicate or misplaced PNG header")),
            b"IDAT" => {
                if dimensions.is_none() || len == 0 {
                    return Err(bad("invalid PNG image data"));
                }
                idat = true;
            }
            b"IEND" => {
                if len != 0 || end != bytes.len() || !idat {
                    return Err(bad("invalid PNG end"));
                }
                return dimensions.ok_or_else(|| bad("PNG header missing"));
            }
            _ if dimensions.is_none() => return Err(bad("PNG header missing")),
            _ => {}
        }
        offset = end;
    }
    Err(bad("PNG end missing"))
}
