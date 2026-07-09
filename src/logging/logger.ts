import type { Logger as PinoLogger } from "pino";
import pino from "pino";

export type Logger = PinoLogger;

export type CorrelationContext = {
  component?: string;
  jobId?: string;
  jobType?: string;
  groupId?: string;
  messageId?: string;
};

export type LoggingOptions = {
  level: string;
};

/**
 * Create a root pino logger that logs to stdout.
 */
export function createLogger(opts: LoggingOptions): Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino/file",
      level: opts.level,
      options: { destination: 1 }, // stdout (fd 1)
    },
  ];

  const transport = pino.transport({ targets });

  return pino({ level: opts.level }, transport);
}

/**
 * Create a child logger that carries correlation context fields
 * (jobId, jobType, groupId, messageId) on every log line.
 */
export function childLogger(base: Logger, ctx: CorrelationContext): Logger {
  return base.child(ctx);
}
