import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable("participants", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    whatsapp_id: {
      type: "text",
      notNull: false,
    },
    display_name: {
      type: "text",
      notNull: true,
    },
  });

  pgm.addConstraint("participants", "participants_display_name_unique", "UNIQUE (display_name)");
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable("participants");
};
