-- A Taiga instance is identified by its base URL: the mirror upserts on it.
ALTER TABLE taiga_instance ADD CONSTRAINT taiga_instance_base_url_key UNIQUE (base_url);
