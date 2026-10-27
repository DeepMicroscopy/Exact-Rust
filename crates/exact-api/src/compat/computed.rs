//! Serializer fields that are Python properties or methods in Django, computed per page (batched).

use super::engine::{db_err, Comp, Ctx};
use crate::error::ApiResult;
use nalgebra::Matrix3;
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashMap;

type Rows = [Map<String, Value>];

fn rid(r: &Map<String, Value>) -> i64 {
    r.get("id").and_then(Value::as_i64).unwrap_or(0)
}

fn ids_of(rows: &Rows, col: &str) -> Vec<i64> {
    rows.iter()
        .filter_map(|r| r.get(col).and_then(Value::as_i64))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Python truthiness of a JSON value (`not self.vector` is `not_in_image`).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Object(m)) => !m.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
    }
}

pub async fn batch(ctx: &Ctx<'_>, c: Comp, rows: &Rows) -> ApiResult<HashMap<i64, Value>> {
    let mut out = HashMap::new();
    match c {
        Comp::Generated => rows.iter().for_each(|r| {
            out.insert(rid(r), json!(false));
        }),
        Comp::GeneratedTrue => rows.iter().for_each(|r| {
            out.insert(rid(r), json!(true));
        }),
        Comp::VerifiedByUser => {
            let ids: Vec<i64> = rows.iter().map(rid).collect();
            let verified: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT annotation_id FROM annotations_verification WHERE user_id = $1 AND verified AND annotation_id = ANY($2)")
                .bind(ctx.viewer.id)
                .bind(&ids)
                .fetch_all(&ctx.s.pool)
                .await
                .map_err(db_err)?;
            for r in rows {
                out.insert(rid(r), json!(verified.contains(&rid(r))));
            }
        }
        Comp::Concealed | Comp::Blurred => {
            let (flag, col) = if c == Comp::Concealed {
                ("enable_concealed", "_concealed")
            } else {
                ("enable_blurred", "_blurred")
            };
            let tids = ids_of(rows, "annotation_type_id");
            let flags: Vec<(i64, bool)> = sqlx::query_as(&format!(
                "SELECT id, {flag} FROM annotations_annotationtype WHERE id = ANY($1)"
            ))
            .bind(&tids)
            .fetch_all(&ctx.s.pool)
            .await
            .map_err(db_err)?;
            let flags: HashMap<i64, bool> = flags.into_iter().collect();
            for r in rows {
                let enabled = r
                    .get("annotation_type_id")
                    .and_then(Value::as_i64)
                    .and_then(|t| flags.get(&t).copied())
                    .unwrap_or(false);
                let set = r.get(col).and_then(Value::as_bool).unwrap_or(false);
                out.insert(rid(r), json!(enabled && set && truthy(r.get("vector"))));
            }
        }
        Comp::HasChanges => {
            let ids: Vec<i64> = rows.iter().map(rid).collect();
            let res = sqlx::query(
                "SELECT v.id, (v.annotation_type_id <> a.annotation_type_id OR v.vector IS DISTINCT FROM a.vector OR v.deleted <> a.deleted) AS changed
                   FROM annotations_annotationversion v JOIN annotations_annotation a ON a.id = v.annotation_id WHERE v.id = ANY($1)",
            )
            .bind(&ids)
            .fetch_all(&ctx.s.pool)
            .await
            .map_err(db_err)?;
            for r in res {
                out.insert(
                    r.try_get::<i64, _>(0).map_err(db_err)?,
                    json!(r.try_get::<bool, _>(1).map_err(db_err)?),
                );
            }
        }
        Comp::PluginOfEntry => {
            let eids = ids_of(rows, "pluginresultentry_id");
            let res: Vec<(i32, i32)> = sqlx::query_as("SELECT e.id, r.plugin_id FROM processing_pluginresultentry e JOIN processing_pluginresult r ON r.id = e.pluginresult_id WHERE e.id = ANY($1)")
                .bind(&eids)
                .fetch_all(&ctx.s.pool)
                .await
                .map_err(db_err)?;
            let m: HashMap<i64, i32> = res.into_iter().map(|(e, p)| (i64::from(e), p)).collect();
            for r in rows {
                out.insert(
                    rid(r),
                    r.get("pluginresultentry_id")
                        .and_then(Value::as_i64)
                        .and_then(|e| m.get(&e))
                        .map(|p| json!(p))
                        .unwrap_or(Value::Null),
                );
            }
        }
        Comp::RotationAngle | Comp::InvMatrix | Comp::Scale | Comp::InvScale => {
            for r in rows {
                out.insert(
                    rid(r),
                    registration_field(c, r.get("transformation_matrix")),
                );
            }
        }
    }
    Ok(out)
}

fn matrix(v: Option<&Value>) -> Option<Matrix3<f64>> {
    let t = v?.as_object()?;
    let g = |k: &str| t.get(k).and_then(Value::as_f64);
    Some(Matrix3::new(
        g("t_00")?,
        g("t_01")?,
        g("t_02")?,
        g("t_10")?,
        g("t_11")?,
        g("t_12")?,
        g("t_20")?,
        g("t_21")?,
        g("t_22")?,
    ))
}

/// `numpy.linalg.pinv` (rcond 1e-15 relative to the largest singular value).
fn pinv(m: &Matrix3<f64>) -> Matrix3<f64> {
    // for invertible matrices the pseudo-inverse is the inverse (LU is the most accurate way to get it)
    if let Some(inv) = m.try_inverse().filter(|i| i.iter().all(|x| x.is_finite())) {
        return inv;
    }
    let svd = m.svd(true, true);
    let eps = 1e-15 * svd.singular_values.max();
    svd.pseudo_inverse(eps).unwrap_or_else(|_| Matrix3::zeros())
}

fn without_rotation(h: &Matrix3<f64>) -> (f64, Matrix3<f64>) {
    let angle = -h[(0, 1)].atan2(h[(0, 0)]) * 180.0 / std::f64::consts::PI;
    let phi = angle * std::f64::consts::PI / 180.0;
    let rot = Matrix3::new(
        phi.cos(),
        -phi.sin(),
        0.0,
        phi.sin(),
        phi.cos(),
        0.0,
        0.0,
        0.0,
        1.0,
    );
    (angle, h * pinv(&rot))
}

fn registration_field(c: Comp, tm: Option<&Value>) -> Value {
    let Some(h) = matrix(tm) else {
        return Value::Null;
    };
    match c {
        Comp::RotationAngle => json!(-h[(0, 1)].atan2(h[(0, 0)]) * 180.0 / std::f64::consts::PI),
        Comp::InvMatrix => {
            let m = pinv(&h);
            let mut o = Map::new();
            for i in 0..3 {
                for j in 0..3 {
                    o.insert(format!("t_{i}{j}"), json!(m[(i, j)]));
                }
            }
            Value::Object(o)
        }
        Comp::Scale => {
            let (_, m) = without_rotation(&h);
            json!([m[(0, 0)], m[(1, 1)]])
        }
        Comp::InvScale => {
            let (_, m) = without_rotation(&h);
            let mi = pinv(&m);
            json!([mi[(0, 0)], mi[(1, 1)]])
        }
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_registration() {
        let tm = json!({"t_00":1.0,"t_01":0.0,"t_02":0.0,"t_10":0.0,"t_11":1.0,"t_12":0.0,"t_20":0.0,"t_21":0.0,"t_22":1.0});
        assert_eq!(
            registration_field(Comp::Scale, Some(&tm)),
            json!([1.0, 1.0])
        );
        assert_eq!(
            registration_field(Comp::RotationAngle, Some(&tm)),
            json!(-0.0)
        );
    }

    #[test]
    fn scaled_and_rotated() {
        let a: f64 = 30f64.to_radians();
        let (c, s) = (a.cos() * 2.0, a.sin() * 2.0);
        let tm = json!({"t_00":c,"t_01":-s,"t_02":5.0,"t_10":s,"t_11":c,"t_12":7.0,"t_20":0.0,"t_21":0.0,"t_22":1.0});
        let ang = registration_field(Comp::RotationAngle, Some(&tm))
            .as_f64()
            .unwrap();
        assert!((ang - 30.0).abs() < 1e-9, "{ang}"); // numpy: -atan2(t_01, t_00) in degrees
        let sc = registration_field(Comp::Scale, Some(&tm));
        assert!(
            (sc[0].as_f64().unwrap() - 2.0).abs() < 1e-9
                && (sc[1].as_f64().unwrap() - 2.0).abs() < 1e-9,
            "{sc}"
        );
    }

    #[test]
    fn missing_matrix_is_null() {
        assert_eq!(registration_field(Comp::InvMatrix, None), Value::Null);
    }

    #[test]
    fn python_truthiness() {
        assert!(!truthy(Some(&json!({}))) && !truthy(None) && !truthy(Some(&Value::Null)));
        assert!(truthy(Some(&json!({"x1": 1}))));
    }
}
