//! `AnnotationType.validate_vector` of EXACT, including its quirks.

use serde_json::{Map, Value};

pub const BOUNDING_BOX: i32 = 1;
pub const POINT: i32 = 2;
pub const LINE: i32 = 3;
pub const MULTI_LINE: i32 = 4;
pub const POLYGON: i32 = 5;
pub const FIXED_SIZE_BOUNDING_BOX: i32 = 6;
pub const GLOBAL: i32 = 7;
pub const SEGMENTATION: i32 = 8;

/// Python `int(value)` for a JSON value; None where Python would raise.
fn py_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite())
                .map(|f| f.trunc() as i64)
        }),
        Value::String(s) => {
            let t = s.trim();
            // int("12"), int(" 12 "), int("+12"), int("1_000") ... but not int("1.5")
            t.replace('_', "").parse::<i64>().ok()
        }
        _ => None,
    }
}

/// Validates `vector` for a type; the values are converted to integers in place, like Django does. `None`
/// (annotation outside of the image) is always valid.
pub fn validate(vector_type: i32, node_count: i32, vector: &mut Value) -> bool {
    let obj: &mut Map<String, Value> = match vector {
        Value::Null => return true,
        Value::Object(o) => o,
        _ => return false,
    };
    for (_, v) in obj.iter_mut() {
        match py_int(v) {
            Some(i) => *v = Value::from(i),
            None => return false,
        }
    }
    let get = |k: &str| obj.get(k).and_then(Value::as_i64);
    let bbox = || {
        // x2 - x1 >= 1 and y2 - y1 >= 1 (a missing coordinate gives -inf / inf) and exactly four entries
        matches!((get("x1"), get("x2")), (Some(a), Some(b)) if b - a >= 1)
            && matches!((get("y1"), get("y2")), (Some(a), Some(b)) if b - a >= 1)
            && obj.len() == 4
    };
    let nodes_ok = |min_len: usize| {
        obj.len() >= min_len && (node_count == 0 || node_count as usize == obj.len() / 2)
    };
    match vector_type {
        BOUNDING_BOX | FIXED_SIZE_BOUNDING_BOX | GLOBAL => bbox(),
        LINE => {
            // EXACT compares with `is not`: only equal small ints (-5..=256, cached by CPython) are "the same object";
            // a missing coordinate is a fresh float('inf')
            let is_not = |a: &str, b: &str| match (get(a), get(b)) {
                (Some(x), Some(y)) => !(x == y && (-5..=256).contains(&x)),
                _ => true,
            };
            is_not("x2", "x1") || (is_not("y2", "y1") && obj.len() == 4)
        }
        POINT => obj.contains_key("x1") && obj.contains_key("y1") && obj.len() == 4,
        POLYGON => nodes_ok(6),
        MULTI_LINE => nodes_ok(4),
        SEGMENTATION => true,
        _ => false,
    }
}

/// `AnnotationType.can_convert`: same vector type, or between the two box types.
pub fn can_convert(from: i32, to: i32) -> bool {
    from == to
        || (matches!(from, BOUNDING_BOX | FIXED_SIZE_BOUNDING_BOX)
            && matches!(to, BOUNDING_BOX | FIXED_SIZE_BOUNDING_BOX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounding_box_needs_four_entries_and_a_positive_extent() {
        let mut v = json!({"x1": 10, "y1": 20, "x2": 30, "y2": 40});
        assert!(validate(BOUNDING_BOX, 0, &mut v));
        assert!(!validate(
            BOUNDING_BOX,
            0,
            &mut json!({"x1": 10, "y1": 20, "x2": 10, "y2": 40})
        ));
        assert!(!validate(
            BOUNDING_BOX,
            0,
            &mut json!({"x1": 10, "y1": 20, "x2": 30})
        ));
        assert!(!validate(
            BOUNDING_BOX,
            0,
            &mut json!({"x1": 1, "y1": 2, "x2": 3, "y2": 4, "x3": 5})
        ));
    }

    #[test]
    fn values_are_cast_to_integers_in_place() {
        let mut v = json!({"x1": "10", "y1": 20.9, "x2": 30, "y2": 40});
        assert!(validate(BOUNDING_BOX, 0, &mut v));
        assert_eq!(v, json!({"x1": 10, "y1": 20, "x2": 30, "y2": 40}));
        assert!(!validate(
            BOUNDING_BOX,
            0,
            &mut json!({"x1": "1.5", "y1": 2, "x2": 3, "y2": 4})
        ));
        assert!(!validate(
            BOUNDING_BOX,
            0,
            &mut json!({"x1": null, "y1": 2, "x2": 3, "y2": 4})
        ));
    }

    #[test]
    fn no_vector_and_non_objects() {
        assert!(validate(BOUNDING_BOX, 0, &mut Value::Null));
        assert!(!validate(BOUNDING_BOX, 0, &mut json!([1, 2, 3, 4])));
        assert!(validate(SEGMENTATION, 0, &mut json!({"anything": 1})));
    }

    #[test]
    fn polygon_node_count_and_point() {
        let mut tri = json!({"x1": 0, "y1": 0, "x2": 5, "y2": 0, "x3": 5, "y3": 5});
        assert!(validate(POLYGON, 0, &mut tri.clone()));
        assert!(validate(POLYGON, 3, &mut tri.clone()));
        assert!(!validate(POLYGON, 4, &mut tri));
        assert!(!validate(
            POLYGON,
            0,
            &mut json!({"x1": 0, "y1": 0, "x2": 5, "y2": 0})
        ));
        assert!(validate(
            POINT,
            0,
            &mut json!({"x1": 1, "y1": 2, "x2": 3, "y2": 4})
        ));
        assert!(!validate(POINT, 0, &mut json!({"x1": 1, "y1": 2})));
    }

    #[test]
    fn line_keeps_the_identity_comparison_quirk() {
        // equal small ints are "the same object": x1 == x2 and y1 == y2 below 257 is rejected
        assert!(!validate(
            LINE,
            0,
            &mut json!({"x1": 5, "y1": 5, "x2": 5, "y2": 5})
        ));
        assert!(validate(
            LINE,
            0,
            &mut json!({"x1": 5, "y1": 5, "x2": 6, "y2": 5})
        ));
        // equal large ints are distinct objects: the "degenerate" line is accepted
        assert!(validate(
            LINE,
            0,
            &mut json!({"x1": 1000, "y1": 1000, "x2": 1000, "y2": 1000})
        ));
    }

    #[test]
    fn conversion_between_types() {
        assert!(can_convert(BOUNDING_BOX, FIXED_SIZE_BOUNDING_BOX));
        assert!(can_convert(POLYGON, POLYGON));
        assert!(!can_convert(POLYGON, BOUNDING_BOX));
    }
}
