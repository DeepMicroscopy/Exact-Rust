//! DRF `LimitOffsetPagination`, `django-filter` value parsing and `drf-flex-fields` handling.

use crate::error::ApiError;
use axum::http::{header, HeaderMap};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub const PAGE_SIZE: i64 = 50;

/// Parsed query string; the last value of a repeated key wins (`QueryDict.get`).
#[derive(Debug, Clone, Default)]
pub struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    pub fn parse(raw: Option<&str>) -> Self {
        Self {
            pairs: form_urlencoded::parse(raw.unwrap_or("").as_bytes())
                .into_owned()
                .collect(),
        }
    }

    pub fn get(&self, k: &str) -> Option<&str> {
        self.pairs
            .iter()
            .rev()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    }

    /// Empty values count as "not given", like django-filter.
    pub fn filter(&self, k: &str) -> Option<&str> {
        self.get(k).filter(|v| !v.is_empty())
    }

    pub fn int(&self, k: &str) -> Result<Option<i64>, ApiError> {
        match self.filter(k) {
            None => Ok(None),
            Some(v) => v
                .trim()
                .parse()
                .map(Some)
                .map_err(|_| ApiError::validation(k, "Enter a number.")),
        }
    }

    /// Django `NullBooleanSelect` semantics: anything unrecognised means "no filter".
    pub fn boolean(&self, k: &str) -> Option<bool> {
        match self.filter(k)? {
            "true" | "True" | "2" => Some(true),
            "false" | "False" | "3" => Some(false),
            _ => None,
        }
    }

    fn with(&self, key: &str, val: Option<String>) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .pairs
            .iter()
            .filter(|(k, _)| k != key)
            .cloned()
            .collect();
        if let Some(val) = val {
            v.push((key.to_string(), val));
        }
        v
    }
}

pub struct Page {
    pub limit: i64,
    pub offset: i64,
}

impl Page {
    pub fn from_query(q: &Query) -> Self {
        // DRF: limit must be a positive integer, otherwise the default applies; offset >= 0 else 0.
        let limit = q
            .get("limit")
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|l| *l > 0)
            .unwrap_or(PAGE_SIZE);
        let offset = q
            .get("offset")
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|o| *o >= 0)
            .unwrap_or(0);
        Self { limit, offset }
    }

    fn url(base: &str, mut pairs: Vec<(String, String)>) -> String {
        pairs.sort_by(|a, b| a.0.cmp(&b.0)); // DRF's replace_query_param sorts by key
        let q = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        if q.is_empty() {
            base.to_string()
        } else {
            format!("{base}?{q}")
        }
    }

    pub fn envelope(
        &self,
        q: &Query,
        headers: &HeaderMap,
        path: &str,
        count: i64,
        results: Vec<Value>,
    ) -> Value {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");
        let base = format!("http://{host}{path}");
        let next = (self.offset + self.limit < count).then(|| {
            let mut p = q.with("limit", Some(self.limit.to_string()));
            p.retain(|(k, _)| k != "offset");
            p.push(("offset".into(), (self.offset + self.limit).to_string()));
            Self::url(&base, p)
        });
        let previous = (self.offset > 0).then(|| {
            let mut p = q.with("limit", Some(self.limit.to_string()));
            p.retain(|(k, _)| k != "offset");
            let prev = self.offset - self.limit;
            if prev > 0 {
                p.push(("offset".into(), prev.to_string()));
            }
            Self::url(&base, p)
        });
        json!({"count": count, "next": next, "previous": previous, "results": results})
    }
}

/// `expand` / `fields` / `omit` query parameters of drf-flex-fields.
#[derive(Debug, Default)]
pub struct Flex {
    pub expand: HashSet<String>,
    pub fields: Option<HashSet<String>>,
    pub omit: HashSet<String>,
}

impl Flex {
    pub fn from_query(q: &Query) -> Self {
        let set = |k: &str| -> Option<HashSet<String>> {
            q.get(k).filter(|v| !v.is_empty()).map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
        };
        Self {
            expand: set("expand").unwrap_or_default(),
            fields: set("fields"),
            omit: set("omit").unwrap_or_default(),
        }
    }

    pub fn expands(&self, field: &str) -> bool {
        self.expand.contains(field) && self.fields.as_ref().is_none_or(|f| f.contains(field))
    }

    /// Whether the field is part of the answer (`fields` names it or is absent, and `omit` does not): what is not wanted is not looked up.
    pub fn wants(&self, field: &str) -> bool {
        self.fields.as_ref().is_none_or(|f| f.contains(field)) && !self.omit.contains(field)
    }

    pub fn apply(&self, obj: &mut Map<String, Value>) {
        if let Some(f) = &self.fields {
            obj.retain(|k, _| f.contains(k));
        }
        obj.retain(|k, _| !self.omit.contains(k));
    }
}

/// DRF `DateTimeField` with `USE_TZ = False`: naive local time in the server's zone, ISO 8601.
pub fn drf_datetime(dt: Option<DateTime<Utc>>, tz: Tz) -> Value {
    match dt {
        None => Value::Null,
        Some(dt) => {
            let l = dt.with_timezone(&tz).naive_local();
            let frac = if l.and_utc().timestamp_subsec_micros() != 0 {
                l.format(".%6f").to_string()
            } else {
                String::new()
            };
            Value::String(format!("{}{}", l.format("%Y-%m-%dT%H:%M:%S"), frac))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_and_omit_decide_which_fields_are_looked_up() {
        let all = Flex::from_query(&Query::parse(Some("limit=5")));
        assert!(all.wants("annotations") && all.wants("id"));
        let omit = Flex::from_query(&Query::parse(Some("omit=annotations%2Cname")));
        assert!(!omit.wants("annotations") && !omit.wants("name") && omit.wants("id"));
        let only = Flex::from_query(&Query::parse(Some("fields=id%2Cname")));
        assert!(only.wants("id") && only.wants("name") && !only.wants("annotations"));
        let both = Flex::from_query(&Query::parse(Some("fields=id%2Cname&omit=name")));
        assert!(both.wants("id") && !both.wants("name"));
    }

    #[test]
    fn limit_offset_defaults_like_drf() {
        let p = Page::from_query(&Query::parse(Some("limit=0&offset=-3")));
        assert_eq!((p.limit, p.offset), (50, 0));
        let p = Page::from_query(&Query::parse(Some("limit=x&offset=7")));
        assert_eq!((p.limit, p.offset), (50, 7));
    }

    #[test]
    fn links_are_sorted_and_previous_drops_offset_on_first_page() {
        let q = Query::parse(Some("expand=team%2Cuser&limit=3&offset=3"));
        let page = Page::from_query(&q);
        let h = HeaderMap::new();
        let v = page.envelope(&q, &h, "/api/x/", 10, vec![]);
        assert_eq!(
            v["next"],
            "http://localhost/api/x/?expand=team%2Cuser&limit=3&offset=6"
        );
        assert_eq!(
            v["previous"],
            "http://localhost/api/x/?expand=team%2Cuser&limit=3"
        );
    }

    #[test]
    fn booleans_follow_django_widget() {
        let q = Query::parse(Some("a=true&b=False&c=1&d="));
        assert_eq!(
            (
                q.boolean("a"),
                q.boolean("b"),
                q.boolean("c"),
                q.boolean("d")
            ),
            (Some(true), Some(false), None, None)
        );
    }

    #[test]
    fn datetime_is_naive_berlin_time() {
        let dt = "2026-10-27T10:00:00.5Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            drf_datetime(Some(dt), chrono_tz::Europe::Berlin),
            "2026-10-27T11:00:00.500000"
        );
        let dt = "2026-07-01T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            drf_datetime(Some(dt), chrono_tz::Europe::Berlin),
            "2026-07-01T12:00:00"
        );
    }

    #[test]
    fn flex_fields_and_omit() {
        let f = Flex::from_query(&Query::parse(Some("fields=id,a&omit=a")));
        let mut o = json!({"id":1,"a":2,"b":3}).as_object().unwrap().clone();
        f.apply(&mut o);
        assert_eq!(Value::Object(o), json!({"id":1}));
    }
}
