import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("messages", {
    from_me: { type: "boolean", notNull: false },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("messages", "from_me");
};
