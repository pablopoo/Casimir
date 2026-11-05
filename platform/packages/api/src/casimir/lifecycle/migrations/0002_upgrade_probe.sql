-- Forward-only control metadata; application tables and native schema are untouched.
CREATE TABLE casimir_install.upgrade_probe (
 id integer PRIMARY KEY CHECK (id=1),
 marker text NOT NULL CHECK (marker='c1_control_schema_2'),
 applied_count integer NOT NULL CHECK (applied_count=1),
 applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO casimir_install.upgrade_probe(id,marker,applied_count)
VALUES(1,'c1_control_schema_2',1);
