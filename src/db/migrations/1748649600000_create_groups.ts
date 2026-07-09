import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("groups", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    whatsapp_id: {
      type: "text",
      notNull: false,
    },
    name: {
      type: "text",
      notNull: true,
    },
    source: {
      type: "text",
      notNull: true,
      check: "source IN ('import', 'live', 'mixed')",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("groups", "groups_name_unique", "UNIQUE (name)");
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("groups");
};
