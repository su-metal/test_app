| table_name           | column_name            | ordinal_position | data_type                | is_nullable |
| -------------------- | ---------------------- | ---------------- | ------------------------ | ----------- |
| line_users           | line_user_id           | 1                | text                     | NO          |
| line_users           | auth_user_id           | 2                | uuid                     | YES         |
| line_users           | created_at             | 3                | timestamp with time zone | YES         |
| orders               | id                     | 1                | uuid                     | NO          |
| orders               | code                   | 2                | text                     | NO          |
| orders               | customer               | 3                | text                     | YES         |
| orders               | items                  | 4                | jsonb                    | NO          |
| orders               | total                  | 5                | integer                  | NO          |
| orders               | placed_at              | 6                | timestamp with time zone | YES         |
| orders               | status                 | 7                | USER-DEFINED             | NO          |
| orders               | store_id               | 8                | uuid                     | NO          |
| orders               | pickup_start           | 9                | timestamp with time zone | YES         |
| orders               | pickup_end             | 10               | timestamp with time zone | YES         |
| orders               | reminded_at            | 11               | timestamp with time zone | YES         |
| orders               | line_user_id           | 12               | text                     | YES         |
| orders               | completed_notified_at  | 13               | timestamp with time zone | YES         |
| products             | id                     | 1                | uuid                     | NO          |
| products             | name                   | 2                | text                     | NO          |
| products             | price                  | 3                | integer                  | NO          |
| products             | stock                  | 4                | integer                  | NO          |
| products             | updated_at             | 5                | timestamp with time zone | YES         |
| products             | store_id               | 6                | uuid                     | NO          |
| products             | main_image_path        | 7                | text                     | YES         |
| products             | sub_image_path1        | 8                | text                     | YES         |
| products             | sub_image_path2        | 9                | text                     | YES         |
| products             | gallery_images         | 10               | jsonb                    | YES         |
| products             | pickup_slot_no         | 11               | smallint                 | YES         |
| products             | publish_at             | 12               | timestamp with time zone | YES         |
| products             | note                   | 13               | text                     | YES         |
| store_applications   | id                     | 1                | uuid                     | NO          |
| store_applications   | store_name             | 2                | text                     | NO          |
| store_applications   | owner_name             | 3                | text                     | NO          |
| store_applications   | email                  | 4                | text                     | NO          |
| store_applications   | phone                  | 5                | text                     | YES         |
| store_applications   | status                 | 6                | text                     | NO          |
| store_applications   | created_at             | 7                | timestamp with time zone | NO          |
| store_pickup_presets | id                     | 1                | uuid                     | NO          |
| store_pickup_presets | store_id               | 2                | uuid                     | NO          |
| store_pickup_presets | slot_no                | 3                | smallint                 | NO          |
| store_pickup_presets | name                   | 4                | text                     | NO          |
| store_pickup_presets | start_time             | 5                | time without time zone   | NO          |
| store_pickup_presets | end_time               | 6                | time without time zone   | NO          |
| store_pickup_presets | slot_minutes           | 7                | integer                  | NO          |
| store_pickup_presets | updated_at             | 8                | timestamp with time zone | NO          |
| stores               | id                     | 1                | uuid                     | NO          |
| stores               | name                   | 2                | text                     | NO          |
| stores               | created_at             | 3                | timestamp with time zone | NO          |
| stores               | lat                    | 4                | double precision         | YES         |
| stores               | lng                    | 5                | double precision         | YES         |
| stores               | address                | 6                | text                     | YES         |
| stores               | cover_image_path       | 7                | text                     | YES         |
| stores               | current_pickup_slot_no | 8                | smallint                 | YES         |
| stores               | tel                    | 9                | text                     | YES         |
| stores               | url                    | 10               | text                     | YES         |
| stores               | hours                  | 11               | text                     | YES         |
| stores               | holiday                | 12               | text                     | YES         |
| stores               | category               | 13               | text                     | YES         |
| stores               | gmap_embed_src         | 14               | text                     | YES         |
| stores               | gmap_url               | 15               | text                     | YES         |
| stores               | place_id               | 16               | text                     | YES         |
| stores               | auth_user_id           | 17               | uuid                     | YES         |
| stores               | email                  | 18               | text                     | YES         |
| user_profiles        | auth_user_id           | 1                | uuid                     | NO          |
| user_profiles        | line_user_id           | 2                | text                     | YES         |
| user_profiles        | created_at             | 3                | timestamp with time zone | YES         |
