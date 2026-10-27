//! The resources of the compat API, one `Spec` each. Field order and names follow the DRF serializers
//! of the Django deployment; filters follow its django-filter FilterSets (see `reference/dump_filters.py`).

use super::engine::{f, Comp, Shape, Spec, F, K, T};
use crate::flt;

macro_rules! eq {
    ($p:literal, $t:expr, $col:literal) => {
        flt!($p, Shape::One($t), concat!($col, " = {}"))
    };
}
macro_rules! lte {
    ($p:literal, $t:expr, $col:literal) => {
        flt!($p, Shape::One($t), concat!($col, " <= {}"))
    };
}
macro_rules! gte {
    ($p:literal, $t:expr, $col:literal) => {
        flt!($p, Shape::One($t), concat!($col, " >= {}"))
    };
}
macro_rules! cont {
    ($p:literal, $col:literal) => {
        flt!($p, Shape::Contains, concat!($col, " LIKE {} ESCAPE '\\'"))
    };
}
macro_rules! inl {
    ($p:literal, $t:expr, $col:literal) => {
        flt!($p, Shape::List($t), concat!($col, " = ANY({})"))
    };
}
macro_rules! rng {
    ($p:literal, $t:expr, $col:literal) => {
        flt!($p, Shape::Range($t), concat!($col, " BETWEEN {} AND {}"))
    };
}
macro_rules! mc {
    ($p:literal, $table:literal, $col:literal) => {
        flt!($p, Shape::ModelChoice($table), concat!($col, " = {}"))
    };
}
macro_rules! mci {
    ($p:literal, $table:literal, $col:literal) => {
        flt!(
            $p,
            Shape::ModelChoiceIn($table),
            concat!($col, " = ANY({})")
        )
    };
}
macro_rules! mm {
    ($p:literal, $table:literal, $sql:literal) => {
        flt!($p, Shape::ModelMulti($table), $sql)
    };
}

const fn id() -> F {
    f("id", "id", K::Id)
}
const fn fk(name: &'static str, col: &'static str, target: &'static str, expand: bool) -> F {
    f(name, col, K::Fk { target, expand })
}

// visibility of rows reachable through an image / image set of one of the viewer's teams
const IMAGE_VISIBLE: &str = "EXISTS (SELECT 1 FROM images_image i JOIN images_imageset s ON s.id = i.image_set_id WHERE i.id = t.image_id AND s.team_id IN {VT})";

// ---- users ---------------------------------------------------------------------------------------------

pub static USER: Spec = Spec {
    name: "User",
    table: "users_user",
    perm: ("users", "user"),
    fields: &[
        id(),
        f("username", "username", K::Str),
        f("is_superuser", "is_superuser", K::Bool),
        f("is_staff", "is_staff", K::Bool),
        f("is_active", "is_active", K::Bool),
        f("last_login", "last_login", K::Dt),
        f(
            "team_set",
            "",
            K::M2m {
                target: "Team",
                through: "users_teammembership",
                left: "user_id",
                right: "team_id",
                expand: true,
            },
        ),
    ],
    scope: "t.id IN (SELECT m.user_id FROM users_teammembership m WHERE m.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("username", T::Str, "t.username"),
        cont!("username__contains", "t.username"),
        eq!("is_superuser", T::Bool, "t.is_superuser"),
        eq!("is_staff", T::Bool, "t.is_staff"),
        eq!("is_active", T::Bool, "t.is_active"),
        eq!("last_login", T::IsoDt, "t.last_login"),
        mm!(
            "team",
            "users_team",
            "t.id IN (SELECT user_id FROM users_teammembership WHERE team_id = ANY({}))"
        ),
    ],
    order: "t.id",
};

pub static TEAM: Spec = Spec {
    name: "Team",
    table: "users_team",
    perm: ("users", "team"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f(
            "members",
            "",
            K::M2m {
                target: "User",
                through: "users_teammembership",
                left: "team_id",
                right: "user_id",
                expand: true,
            },
        ),
        f(
            "image_sets",
            "",
            K::Rev {
                target: "ImageSet",
                table: "images_imageset",
                col: "team_id",
                expand: true,
            },
        ),
        f(
            "product_set",
            "",
            K::Rev {
                target: "Product",
                table: "administration_product",
                col: "team_id",
                expand: true,
            },
        ),
        f(
            "memberships",
            "",
            K::Rev {
                target: "TeamMembership",
                table: "users_teammembership",
                col: "team_id",
                expand: true,
            },
        ),
    ],
    scope: "t.id IN {VT}",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        mm!(
            "members",
            "users_user",
            "t.id IN (SELECT team_id FROM users_teammembership WHERE user_id = ANY({}))"
        ),
        mm!(
            "image_sets",
            "images_imageset",
            "t.id IN (SELECT team_id FROM images_imageset WHERE id = ANY({}))"
        ),
        mm!(
            "memberships",
            "users_teammembership",
            "t.id IN (SELECT team_id FROM users_teammembership WHERE id = ANY({}))"
        ),
    ],
    order: "t.id",
};

pub static MEMBERSHIP: Spec = Spec {
    name: "TeamMembership",
    table: "users_teammembership",
    perm: ("users", "teammembership"),
    fields: &[
        id(),
        f("is_admin", "is_admin", K::Bool),
        fk("team", "team_id", "Team", true),
        fk("user", "user_id", "User", true),
    ],
    scope: "t.team_id IN {VT}",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("is_admin", T::Bool, "t.is_admin"),
        mc!("team", "users_team", "t.team_id"),
        mc!("user", "users_user", "t.user_id"),
    ],
    order: "t.id",
};

// ---- administration --------------------------------------------------------------------------------------

pub static PRODUCT: Spec = Spec {
    name: "Product",
    table: "administration_product",
    perm: ("administration", "product"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("description", "description", K::Str),
        fk("team", "team_id", "Team", true),
        fk("creator", "creator_id", "User", true),
        f("imagesets", "", K::M2m { target: "ImageSet", through: "administration_product_imagesets", left: "product_id", right: "imageset_id", expand: true }),
        f("annotationtype_set", "", K::Rev { target: "AnnotationType", table: "annotations_annotationtype", col: "product_id", expand: true }),
    ],
    scope: "t.team_id IN {VT}",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        eq!("description", T::Str, "t.description"),
        cont!("description__contains", "t.description"),
        mc!("team", "users_team", "t.team_id"),
        mc!("creator", "users_user", "t.creator_id"),
        mm!("imagesets", "images_imageset", "t.id IN (SELECT product_id FROM administration_product_imagesets WHERE imageset_id = ANY({}))"),
        mm!("annotationtype", "annotations_annotationtype", "t.id IN (SELECT product_id FROM annotations_annotationtype WHERE id = ANY({}))"),
    ],
    order: "t.id",
};

// ---- annotation types ----------------------------------------------------------------------------------

pub static ANNOTATION_TYPE: Spec = Spec {
    name: "AnnotationType",
    table: "annotations_annotationtype",
    perm: ("annotations", "annotationtype"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("vector_type", "vector_type", K::Int),
        f("node_count", "node_count", K::Int),
        f("enable_concealed", "enable_concealed", K::Bool),
        f("enable_blurred", "enable_blurred", K::Bool),
        f("color_code", "color_code", K::Str),
        f("multi_frame", "multi_frame", K::Bool),
        f("default_width", "default_width", K::Float),
        f("default_height", "default_height", K::Float),
        f("size_unit", "size_unit", K::Str),
        f("sort_order", "sort_order", K::Int),
        f("closed", "closed", K::Bool),
        f("area_hit_test", "area_hit_test", K::Bool),
        fk("product", "product_id", "Product", true),
    ],
    scope: "t.product_id IN (SELECT p.id FROM administration_product p WHERE p.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        inl!("id__in", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        eq!("vector_type", T::Num, "t.vector_type"),
        lte!("vector_type__lte", T::Num, "t.vector_type"),
        gte!("vector_type__gte", T::Num, "t.vector_type"),
        rng!("vector_type__range", T::Num, "t.vector_type"),
        inl!("vector_type__in", T::Num, "t.vector_type"),
        eq!("active", T::Bool, "t.active"),
        mc!("product", "administration_product", "t.product_id"),
    ],
    order: "t.id",
};

// ---- images ------------------------------------------------------------------------------------------------

pub static IMAGE: Spec = Spec {
    name: "Image",
    table: "images_image",
    perm: ("images", "image"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("filename", "filename", K::Str),
        f("time", "time", K::Dt),
        f("height", "height", K::Int),
        f("width", "width", K::Int),
        f("depth", "depth", K::Int),
        f("frames", "frames", K::Int),
        f("channels", "channels", K::Int),
        f("mpp", "mpp", K::Float),
        f("objectivePower", "objectivePower", K::Float),
        f("FrameDescriptions", "", K::Rev { target: "FrameDescription", table: "images_framedescription", col: "\"Image_id\"", expand: true }),
        f("defaultFrame", "defaultFrame", K::Int),
        f("image_type", "image_type", K::Int),
        fk("image_set", "image_set_id", "ImageSet", true),
        fk("crop_source", "crop_source_id", "Image", true),
        f("crop_x", "crop_x", K::Int),
        f("crop_y", "crop_y", K::Int),
        f("crop_frame", "crop_frame", K::Int),
        f("annotations", "", K::Rev { target: "Annotation", table: "annotations_annotation", col: "image_id", expand: true }),
    ],
    scope: "t.image_set_id IN (SELECT s.id FROM images_imageset s WHERE s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        inl!("id__in", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        inl!("name__in", T::Str, "t.name"),
        eq!("filename", T::Str, "t.filename"),
        cont!("filename__contains", "t.filename"),
        inl!("filename__in", T::Str, "t.filename"),
        eq!("time", T::Dt, "t.time"),
        eq!("mpp", T::Num, "t.mpp"),
        rng!("mpp__range", T::Num, "t.mpp"),
        eq!("objectivePower", T::Num, "t.\"objectivePower\""),
        rng!("objectivePower__range", T::Num, "t.\"objectivePower\""),
        eq!("defaultFrame", T::Num, "t.\"defaultFrame\""),
        rng!("defaultFrame__range", T::Num, "t.\"defaultFrame\""),
        eq!("width", T::Num, "t.width"),
        rng!("width__range", T::Num, "t.width"),
        eq!("height", T::Num, "t.height"),
        rng!("height__range", T::Num, "t.height"),
        mc!("image_set", "images_imageset", "t.image_set_id"),
        flt!("image_type", Shape::One(T::Choice(&[0, 1, 2])), "t.image_type = {}"),
        flt!("annotation_type", Shape::One(T::Num), concat!("EXISTS (SELECT 1 ", "FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = t.id AND NOT a.deleted AND at.active AND at.id = {})")),
        flt!("num_annotations_min", Shape::One(T::Int), concat!("(SELECT count(*) ", "FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = t.id AND NOT a.deleted AND at.active) >= {}")),
        flt!("num_annotations_max", Shape::One(T::Int), concat!("(SELECT count(*) ", "FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = t.id AND NOT a.deleted AND at.active) <= {}")),
        flt!(
            "verified",
            Shape::One(T::NullBool),
            "CASE WHEN {} THEN EXISTS (SELECT 1 FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = t.id AND NOT a.deleted AND at.active AND v.verified)
                  ELSE (NOT EXISTS (SELECT 1 FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = t.id AND NOT a.deleted AND at.active)
                        OR EXISTS (SELECT 1 FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id LEFT JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = t.id AND NOT a.deleted AND at.active AND (v.id IS NULL OR NOT v.verified))) END"
        ),
    ],
    order: "t.id",
};

pub static FRAME_DESCRIPTION: Spec = Spec {
    name: "FrameDescription",
    table: "images_framedescription",
    perm: ("images", "framedescription"),
    fields: &[
        f("description", "description", K::Str),
        f("frame_id", "frame_id", K::Int),
        f("frame_type", "frame_type", K::Int),
    ],
    scope: "",
    filters: &[],
    order: "t.id",
};

pub static IMAGE_SET: Spec = Spec {
    name: "ImageSet",
    table: "images_imageset",
    perm: ("images", "imageset"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("path", "path", K::Str),
        f("location", "location", K::Str),
        f("description", "description", K::Str),
        f("images", "", K::Rev { target: "Image", table: "images_image", col: "image_set_id", expand: true }),
        f("product_set", "", K::M2m { target: "Product", through: "administration_product_imagesets", left: "imageset_id", right: "product_id", expand: true }),
        fk("main_annotation_type", "main_annotation_type_id", "AnnotationType", true),
        f("set_tags", "", K::M2m { target: "SetTag", through: "images_settag_imagesets", left: "imageset_id", right: "settag_id", expand: true }),
        fk("team", "team_id", "Team", true),
        fk("creator", "creator_id", "User", true),
        f("collaboration_type", "collaboration_type", K::Int),
    ],
    scope: "t.team_id IN {VT}",
    filters: &[
        eq!("id", T::Num, "t.id"),
        inl!("id__in", T::Num, "t.id"),
        eq!("path", T::Str, "t.path"),
        cont!("path__contains", "t.path"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        inl!("name__in", T::Str, "t.name"),
        eq!("location", T::Str, "t.location"),
        cont!("location__contains", "t.location"),
        eq!("description", T::Str, "t.description"),
        cont!("description__contains", "t.description"),
        eq!("time", T::Dt, "t.time"),
        rng!("time__range", T::Dt, "t.time"),
        mc!("team", "users_team", "t.team_id"),
        mc!("creator", "users_user", "t.creator_id"),
        eq!("public", T::Bool, "t.public"),
        mc!("main_annotation_type", "annotations_annotationtype", "t.main_annotation_type_id"),
        mm!("set_tags", "images_settag", "t.id IN (SELECT imageset_id FROM images_settag_imagesets WHERE settag_id = ANY({}))"),
        mm!("set_versions", "images_setversion", "t.id IN (SELECT imageset_id FROM images_setversion_imagesets WHERE setversion_id = ANY({}))"),
        mm!("product", "administration_product", "t.id IN (SELECT imageset_id FROM administration_product_imagesets WHERE product_id = ANY({}))"),
        flt!("collaboration_type", Shape::One(T::Choice(&[0, 1, 2])), "t.collaboration_type = {}"),
        flt!("priority", Shape::One(T::Choice(&[1, 0, -1])), "t.priority = {}"),
        flt!("zip_state", Shape::One(T::Choice(&[0, 1, 2])), "t.zip_state = {}"),
        flt!("images", Shape::ModelChoice("images_image"), "t.id IN (SELECT image_set_id FROM images_image WHERE id = {})"),
    ],
    order: "t.id",
};

pub static SET_TAG: Spec = Spec {
    name: "SetTag",
    table: "images_settag",
    perm: ("images", "settag"),
    fields: &[id(), f("name", "name", K::Str), f("imagesets", "", K::M2m { target: "ImageSet", through: "images_settag_imagesets", left: "settag_id", right: "imageset_id", expand: true })],
    scope: "EXISTS (SELECT 1 FROM images_settag_imagesets si JOIN images_imageset s ON s.id = si.imageset_id WHERE si.settag_id = t.id AND s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        mm!("imagesets", "images_imageset", "t.id IN (SELECT settag_id FROM images_settag_imagesets WHERE imageset_id = ANY({}))"),
    ],
    order: "t.id",
};

pub static SET_VERSION: Spec = Spec {
    name: "SetVersion",
    table: "images_setversion",
    perm: ("images", "setversion"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("imagesets", "", K::M2m { target: "ImageSet", through: "images_setversion_imagesets", left: "setversion_id", right: "imageset_id", expand: true }),
        f("time", "time", K::Dt),
        f("annotationversion_set", "", K::Rev { target: "AnnotationVersion", table: "annotations_annotationversion", col: "version_id", expand: true }),
        f("file", "file", K::File),
    ],
    scope: "EXISTS (SELECT 1 FROM images_setversion_imagesets si JOIN images_imageset s ON s.id = si.imageset_id WHERE si.setversion_id = t.id AND s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        mm!("imagesets", "images_imageset", "t.id IN (SELECT setversion_id FROM images_setversion_imagesets WHERE imageset_id = ANY({}))"),
    ],
    order: "t.id",
};

pub static SCREENING_MODE: Spec = Spec {
    name: "ScreeningMode",
    table: "images_screeningmode",
    perm: ("images", "screeningmode"),
    fields: &[
        id(),
        fk("image", "image_id", "Image", true),
        fk("user", "user_id", "User", true),
        f("screening_tiles", "screening_tiles", K::Json),
        f("x_steps", "x_steps", K::Int),
        f("y_steps", "y_steps", K::Int),
        f("x_resolution", "x_resolution", K::Int),
        f("y_resolution", "y_resolution", K::Int),
        f("current_index", "current_index", K::Int),
    ],
    scope: IMAGE_VISIBLE,
    filters: &[
        eq!("id", T::Num, "t.id"),
        mc!("image", "images_image", "t.image_id"),
        mc!("user", "users_user", "t.user_id"),
    ],
    order: "t.id",
};

pub static IMAGE_REGISTRATION: Spec = Spec {
    name: "ImageRegistration",
    table: "images_imageregistration",
    perm: ("images", "imageregistration"),
    fields: &[
        id(),
        fk("source_image", "source_image_id", "Image", true),
        fk("target_image", "target_image_id", "Image", true),
        f("transformation_matrix", "transformation_matrix", K::Json),
        f("registration_error", "registration_error", K::Float),
        f("runtime", "runtime", K::Int),
        f("file", "file", K::File),
        f("rotation_angle", "", K::Comp(Comp::RotationAngle)),
        f("inv_matrix", "", K::Comp(Comp::InvMatrix)),
        f("get_scale", "", K::Comp(Comp::Scale)),
        f("get_inv_scale", "", K::Comp(Comp::InvScale)),
    ],
    scope: "EXISTS (SELECT 1 FROM images_image i JOIN images_imageset s ON s.id = i.image_set_id WHERE i.id = t.source_image_id AND s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        inl!("id__in", T::Num, "t.id"),
        mc!("target_image", "images_image", "t.target_image_id"),
        mci!("target_image__in", "images_image", "t.target_image_id"),
        mc!("source_image", "images_image", "t.source_image_id"),
        mci!("source_image__in", "images_image", "t.source_image_id"),
        rng!("registration_error__range", T::Num, "t.registration_error"),
        rng!("runtime__range", T::Num, "t.runtime"),
    ],
    order: "t.id",
};

// ---- annotations -------------------------------------------------------------------------------------------

pub static ANNOTATION: Spec = Spec {
    name: "Annotation",
    table: "annotations_annotation",
    perm: ("annotations", "annotation"),
    fields: &[
        fk("annotation_type", "annotation_type_id", "AnnotationType", true),
        id(),
        f("vector", "vector", K::Json),
        f("verified_by_user", "", K::Comp(Comp::VerifiedByUser)),
        fk("image", "image_id", "Image", true),
        f("concealed", "", K::Comp(Comp::Concealed)),
        f("blurred", "", K::Comp(Comp::Blurred)),
        fk("last_editor", "last_editor_id", "User", true),
        f("last_edit_time", "last_edit_time", K::Dt),
        fk("user", "user_id", "User", true),
        f("time", "time", K::Dt),
        f("generated", "", K::Comp(Comp::Generated)),
        f("deleted", "deleted", K::Bool),
        f("description", "description", K::Str),
        f("unique_identifier", "unique_identifier", K::Uuid),
        f("uploaded_media_files", "", K::Rev { target: "AnnotationMediaFile", table: "annotations_annotationmediafile", col: "annotation_id", expand: true }),
        f("meta_data", "meta_data", K::Json),
        f("annotationversion_set", "", K::Rev { target: "AnnotationVersion", table: "annotations_annotationversion", col: "annotation_id", expand: true }),
    ],
    scope: IMAGE_VISIBLE,
    filters: &[
        eq!("id", T::Num, "t.id"),
        inl!("id__in", T::Num, "t.id"),
        eq!("time", T::Dt, "t.time"),
        lte!("time__lte", T::Dt, "t.time"),
        gte!("time__gte", T::Dt, "t.time"),
        rng!("time__range", T::Dt, "t.time"),
        eq!("last_edit_time", T::Dt, "t.last_edit_time"),
        lte!("last_edit_time__lte", T::Dt, "t.last_edit_time"),
        gte!("last_edit_time__gte", T::Dt, "t.last_edit_time"),
        rng!("last_edit_time__range", T::Dt, "t.last_edit_time"),
        eq!("unique_identifier", T::Uuid, "t.unique_identifier"),
        flt!("unique_identifier__contains", Shape::One(T::Uuid), "t.unique_identifier::text LIKE '%' || ({})::text || '%'"),
        inl!("unique_identifier__in", T::Uuid, "t.unique_identifier"),
        eq!("description", T::Str, "t.description"),
        cont!("description__contains", "t.description"),
        eq!("deleted", T::Bool, "t.deleted"),
        flt!("image__image_set", Shape::ModelChoice("images_imageset"), "EXISTS (SELECT 1 FROM images_image i WHERE i.id = t.image_id AND i.image_set_id = {})"),
        flt!("image__image_set__in", Shape::ModelChoiceIn("images_imageset"), "EXISTS (SELECT 1 FROM images_image i WHERE i.id = t.image_id AND i.image_set_id = ANY({}))"),
        mc!("image", "images_image", "t.image_id"),
        mci!("image__in", "images_image", "t.image_id"),
        flt!("image__image_type", Shape::One(T::Choice(&[0, 1, 2])), "EXISTS (SELECT 1 FROM images_image i WHERE i.id = t.image_id AND i.image_type = {})"),
        flt!("image__image_type__in", Shape::List(T::Num), "EXISTS (SELECT 1 FROM images_image i WHERE i.id = t.image_id AND i.image_type = ANY({}))"),
        mc!("user", "users_user", "t.user_id"),
        mc!("annotation_type", "annotations_annotationtype", "t.annotation_type_id"),
        mci!("annotation_type__in", "annotations_annotationtype", "t.annotation_type_id"),
        mm!("verified_by", "users_user", "t.id IN (SELECT annotation_id FROM annotations_verification WHERE user_id = ANY({}))"),
        mm!("annotationversion", "annotations_annotationversion", "t.id IN (SELECT annotation_id FROM annotations_annotationversion WHERE id = ANY({}))"),
        // the Django filters for the *_min bounds only exclude annotations without vector (their `gte` is never applied)
        flt!("vector_x_min", Shape::One(T::Int), "t.vector IS NOT NULL AND {}::bigint IS NOT NULL"),
        flt!("vector_x_max", Shape::One(T::Int), "t.vector IS NOT NULL AND (t.vector -> 'x1') < to_jsonb({}::bigint)"),
        flt!("vector_y_min", Shape::One(T::Int), "t.vector IS NOT NULL AND {}::bigint IS NOT NULL"),
        flt!("vector_y_max", Shape::One(T::Int), "t.vector IS NOT NULL AND (t.vector -> 'y1') < to_jsonb({}::bigint)"),
        flt!("meta_data__isnull", Shape::One(T::NullBool), "(t.meta_data IS NULL) = {}"),
        flt!("vector__isnull", Shape::One(T::NullBool), "(t.vector IS NULL) = {}"),
        flt!("vector_type", Shape::One(T::Num), "EXISTS (SELECT 1 FROM annotations_annotationtype at WHERE at.id = t.annotation_type_id AND at.vector_type = {})"),
    ],
    order: "t.id",
};

pub static ANNOTATION_VERSION: Spec = Spec {
    name: "AnnotationVersion",
    table: "annotations_annotationversion",
    perm: ("annotations", "annotationversion"),
    fields: &[
        id(),
        fk("version", "version_id", "SetVersion", true),
        fk("annotation", "annotation_id", "Annotation", true),
        fk("image", "image_id", "Image", true),
        fk("annotation_type", "annotation_type_id", "AnnotationType", true),
        f("deleted", "deleted", K::Bool),
        f("vector", "vector", K::Json),
        f("has_changes", "", K::Comp(Comp::HasChanges)),
    ],
    scope: IMAGE_VISIBLE,
    filters: &[
        eq!("id", T::Num, "t.id"),
        mc!("version", "images_setversion", "t.version_id"),
        mc!("annotation", "annotations_annotation", "t.annotation_id"),
        mc!("image", "images_image", "t.image_id"),
        eq!("deleted", T::Bool, "t.deleted"),
        mc!("annotation_type", "annotations_annotationtype", "t.annotation_type_id"),
        flt!(
            "has_changes",
            Shape::One(T::NullBool),
            "({} = false OR EXISTS (SELECT 1 FROM annotations_annotation a WHERE a.id = t.annotation_id AND (t.vector IS DISTINCT FROM a.vector OR t.annotation_type_id <> a.annotation_type_id OR t.deleted <> a.deleted) AND NOT (t.vector IS NULL AND a.vector IS NULL)))"
        ),
    ],
    order: "t.id",
};

pub static ANNOTATION_MEDIA_FILE: Spec = Spec {
    name: "AnnotationMediaFile",
    table: "annotations_annotationmediafile",
    perm: ("annotations", "annotationmediafile"),
    fields: &[id(), f("name", "name", K::Str), f("media_file_type", "media_file_type", K::Int), f("file", "file", K::File), fk("annotation", "annotation_id", "Annotation", true)],
    scope: "EXISTS (SELECT 1 FROM annotations_annotation a JOIN images_image i ON i.id = a.image_id JOIN images_imageset s ON s.id = i.image_set_id WHERE a.id = t.annotation_id AND s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        eq!("name", T::Str, "t.name"),
        cont!("name__contains", "t.name"),
        mc!("annotation", "annotations_annotation", "t.annotation_id"),
        flt!("media_file_type", Shape::One(T::Choice(&[1, 2, 3, 4])), "t.media_file_type = {}"),
    ],
    order: "t.id",
};

pub static VERIFICATION: Spec = Spec {
    name: "Verification",
    table: "annotations_verification",
    perm: ("annotations", "verification"),
    fields: &[id(), fk("annotation", "annotation_id", "Annotation", true), fk("user", "user_id", "User", true), f("time", "time", K::Dt), f("verified", "verified", K::Bool)],
    scope: "EXISTS (SELECT 1 FROM annotations_annotation a JOIN images_image i ON i.id = a.image_id JOIN images_imageset s ON s.id = i.image_set_id WHERE a.id = t.annotation_id AND s.team_id IN {VT})",
    filters: &[
        eq!("id", T::Num, "t.id"),
        mc!("annotation", "annotations_annotation", "t.annotation_id"),
        mc!("user", "users_user", "t.user_id"),
        eq!("time", T::IsoDt, "t.time"),
        lte!("time__lte", T::IsoDt, "t.time"),
        gte!("time__gte", T::IsoDt, "t.time"),
        rng!("time__range", T::IsoDt, "t.time"),
        eq!("verified", T::Bool, "t.verified"),
    ],
    order: "t.id",
};

pub static LOG_IMAGE_ACTION: Spec = Spec {
    name: "LogImageAction",
    table: "annotations_logimageaction",
    perm: ("annotations", "logimageaction"),
    fields: &[
        id(),
        fk("image", "image_id", "Image", true),
        fk("user", "user_id", "User", true),
        f("time", "time", K::Dt),
        f("action", "action", K::Int),
        f("ip", "ip", K::Inet),
    ],
    scope: IMAGE_VISIBLE,
    filters: &[
        eq!("id", T::Num, "t.id"),
        mc!("image", "images_image", "t.image_id"),
        mc!("user", "users_user", "t.user_id"),
        eq!("time", T::Dt, "t.time"),
        lte!("time__lte", T::Dt, "t.time"),
        gte!("time__gte", T::Dt, "t.time"),
        rng!("time__range", T::Dt, "t.time"),
        eq!("ip", T::Str, "host(t.ip)"),
        cont!("ip__contains", "host(t.ip)"),
        flt!("action", Shape::One(T::Choice(&[1, 2])), "t.action = {}"),
    ],
    order: "t.id",
};

// ---- processing (visible to every authenticated user in Django: no team scoping) ---------------------------

pub static PLUGIN: Spec = Spec {
    name: "Plugin",
    table: "processing_plugin",
    perm: ("processing", "plugin"),
    fields: &[
        id(),
        f("name", "name", K::Str),
        f("author", "author", K::Str),
        f("contact", "contact", K::Str),
        f("package", "package", K::Str),
        f("abouturl", "abouturl", K::Str),
        f("icon", "icon", K::File),
        f("products", "", K::M2m { target: "Product", through: "processing_plugin_products", left: "plugin_id", right: "product_id", expand: true }),
        f("results", "", K::Rev { target: "PluginResult", table: "processing_pluginresult", col: "plugin_id", expand: true }),
    ],
    scope: "",
    filters: &[flt!(
        "imageset_from_image_id",
        Shape::One(T::Int),
        "t.id IN (SELECT pp.plugin_id FROM processing_plugin_products pp WHERE pp.product_id IN (SELECT ap.product_id FROM administration_product_imagesets ap WHERE ap.imageset_id = (SELECT image_set_id FROM images_image WHERE id = {})))"
    )],
    order: "t.name DESC, t.id DESC",
};

pub static PLUGIN_JOB: Spec = Spec {
    name: "PluginJob",
    table: "processing_pluginjob",
    perm: ("processing", "pluginjob"),
    fields: &[
        id(),
        fk("creator", "creator_id", "User", true),
        fk("plugin", "plugin_id", "Plugin", false),
        f("created_time", "created_time", K::Dt),
        f("eta_time", "eta_time", K::Dt),
        fk("image", "image_id", "Image", false),
        f("error_message", "error_message", K::Str),
        f("error_detail", "error_detail", K::Str),
        f("attached_worker", "attached_worker", K::Str),
        f("processing_complete", "processing_complete", K::Float),
        f("updated_time", "updated_time", K::Dt),
        f(
            "result",
            "",
            K::RevOne {
                target: "PluginResult",
                table: "processing_pluginresult",
                col: "job_id",
                expand: true,
            },
        ),
    ],
    scope: "",
    filters: &[
        flt!("image_id", Shape::One(T::Int), "t.image_id = {}"),
        flt!("user_id", Shape::One(T::Int), "t.creator_id = {}"),
        flt!("filter_ids", Shape::List(T::Int), "t.id = ANY({})"),
    ],
    order: "t.created_time DESC, t.id DESC",
};

pub static PLUGIN_RESULT: Spec = Spec {
    name: "PluginResult",
    table: "processing_pluginresult",
    perm: ("processing", "pluginresult"),
    fields: &[
        id(),
        fk("image", "image_id", "Image", true),
        fk("job", "job_id", "PluginJob", true),
        fk("plugin", "plugin_id", "Plugin", true),
        f("default_alpha", "default_alpha", K::Float),
        f("completed_time", "completed_time", K::Dt),
        f("created_time", "created_time", K::Dt),
        f(
            "entries",
            "",
            K::Rev {
                target: "PluginResultEntry",
                table: "processing_pluginresultentry",
                col: "pluginresult_id",
                expand: true,
            },
        ),
    ],
    scope: "",
    filters: &[
        flt!("image_id", Shape::One(T::Int), "t.image_id = {}"),
        flt!("job_id", Shape::One(T::Int), "t.job_id = {}"),
        flt!("plugin_id", Shape::One(T::Int), "t.plugin_id = {}"),
    ],
    order: "t.created_time DESC, t.id DESC",
};

pub static PLUGIN_RESULT_ENTRY: Spec = Spec {
    name: "PluginResultEntry",
    table: "processing_pluginresultentry",
    perm: ("processing", "pluginresultentry"),
    fields: &[
        id(),
        fk("pluginresult", "pluginresult_id", "PluginResult", true),
        f("created_time", "created_time", K::Dt),
        f("name", "name", K::Str),
        f("visible", "visible", K::Bool),
        f("default_threshold", "default_threshold", K::Float),
        f(
            "annotation_results",
            "",
            K::Rev {
                target: "PluginResultAnnotation",
                table: "processing_pluginresultannotation",
                col: "pluginresultentry_id",
                expand: true,
            },
        ),
        f(
            "bitmap_results",
            "",
            K::Rev {
                target: "PluginResultBitmap",
                table: "processing_pluginresultbitmap",
                col: "pluginresultentry_id",
                expand: true,
            },
        ),
    ],
    scope: "",
    filters: &[],
    order: "t.created_time DESC, t.id DESC",
};

pub static PLUGIN_RESULT_ANNOTATION: Spec = Spec {
    name: "PluginResultAnnotation",
    table: "processing_pluginresultannotation",
    perm: ("processing", "pluginresultannotation"),
    fields: &[
        id(),
        fk("annotation_type", "annotation_type_id", "AnnotationType", false),
        fk("pluginresultentry", "pluginresultentry_id", "PluginResultEntry", true),
        f("meta_data", "meta_data", K::Json),
        f("vector", "vector", K::Json),
        f("score", "score", K::Float),
        f("unique_identifier", "unique_identifier", K::Uuid),
        f("generated", "", K::Comp(Comp::GeneratedTrue)),
        f("plugin", "", K::Comp(Comp::PluginOfEntry)),
        fk("image", "image_id", "Image", true),
        f("time", "time", K::Dt),
    ],
    scope: "",
    filters: &[
        flt!("image", Shape::One(T::Int), "t.image_id = {}"),
        flt!("annotation_type", Shape::One(T::Int), "t.annotation_type_id = {}"),
        flt!("pluginresultentry", Shape::One(T::Int), "t.pluginresultentry_id = {}"),
        flt!("plugin", Shape::One(T::Int), "t.pluginresultentry_id IN (SELECT e.id FROM processing_pluginresultentry e JOIN processing_pluginresult r ON r.id = e.pluginresult_id WHERE r.plugin_id = {})"),
    ],
    order: "t.id DESC",
};

pub static PLUGIN_RESULT_BITMAP: Spec = Spec {
    name: "PluginResultBitmap",
    table: "processing_pluginresultbitmap",
    perm: ("processing", "pluginresultbitmap"),
    fields: &[
        id(),
        f("bitmap", "bitmap", K::File),
        f("channels", "channels", K::Int),
        f("default_alpha", "default_alpha", K::Float),
        f("default_threshold", "default_threshold", K::Float),
        f("meta_data", "meta_data", K::Json),
        f("name", "name", K::Str),
        f("scale_max", "scale_max", K::Float),
        f("plugin", "", K::Comp(Comp::PluginOfEntry)),
        f("scale_min", "scale_min", K::Float),
        f("location_rect", "location_rect", K::Json),
        f("frame", "frame", K::Int),
        fk(
            "pluginresultentry",
            "pluginresultentry_id",
            "PluginResultEntry",
            true,
        ),
        fk("image", "image_id", "Image", true),
    ],
    scope: "",
    filters: &[flt!("image", Shape::One(T::Int), "t.image_id = {}")],
    order: "t.id DESC",
};

pub fn by_name(name: &str) -> &'static Spec {
    match name {
        "User" => &USER,
        "Team" => &TEAM,
        "TeamMembership" => &MEMBERSHIP,
        "Product" => &PRODUCT,
        "AnnotationType" => &ANNOTATION_TYPE,
        "Image" => &IMAGE,
        "FrameDescription" => &FRAME_DESCRIPTION,
        "ImageSet" => &IMAGE_SET,
        "SetTag" => &SET_TAG,
        "SetVersion" => &SET_VERSION,
        "ScreeningMode" => &SCREENING_MODE,
        "ImageRegistration" => &IMAGE_REGISTRATION,
        "Annotation" => &ANNOTATION,
        "AnnotationVersion" => &ANNOTATION_VERSION,
        "AnnotationMediaFile" => &ANNOTATION_MEDIA_FILE,
        "Verification" => &VERIFICATION,
        "LogImageAction" => &LOG_IMAGE_ACTION,
        "Plugin" => &PLUGIN,
        "PluginJob" => &PLUGIN_JOB,
        "PluginResult" => &PLUGIN_RESULT,
        "PluginResultEntry" => &PLUGIN_RESULT_ENTRY,
        "PluginResultAnnotation" => &PLUGIN_RESULT_ANNOTATION,
        "PluginResultBitmap" => &PLUGIN_RESULT_BITMAP,
        other => panic!("unknown resource spec {other}"),
    }
}

/// (URL group, URL name, spec) of the router registrations of the Django API (`exact.api`).
pub const ROUTES: &[(&str, &str, &str)] = &[
    ("users", "users", "User"),
    ("users", "teams", "Team"),
    ("users", "team_membership", "TeamMembership"),
    ("images", "images", "Image"),
    ("images", "image_sets", "ImageSet"),
    ("images", "set_tags", "SetTag"),
    ("images", "set_versions", "SetVersion"),
    ("images", "screening_modes", "ScreeningMode"),
    ("images", "registration", "ImageRegistration"),
    ("annotations", "annotations", "Annotation"),
    ("annotations", "annotation_versions", "AnnotationVersion"),
    ("annotations", "annotation_types", "AnnotationType"),
    (
        "annotations",
        "annotation_media_files",
        "AnnotationMediaFile",
    ),
    ("annotations", "verifications", "Verification"),
    ("annotations", "log_image_actions", "LogImageAction"),
    ("administration", "products", "Product"),
    ("processing", "plugins", "Plugin"),
    ("processing", "pluginjobs", "PluginJob"),
    ("processing", "pluginresults", "PluginResult"),
    ("processing", "pluginresultentrys", "PluginResultEntry"),
    (
        "processing",
        "pluginresultannotations",
        "PluginResultAnnotation",
    ),
    ("processing", "pluginresultbitmaps", "PluginResultBitmap"),
];

pub fn find(group: &str, name: &str) -> Option<&'static Spec> {
    ROUTES
        .iter()
        .find(|(g, n, _)| *g == group && *n == name)
        .map(|(_, _, s)| by_name(s))
}
