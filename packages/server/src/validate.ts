/**
 * Input validation. Everything that arrives over HTTP is parsed through the frozen zod schemas
 * from `@vfox/shared` before it reaches the core, so the API can never accept a shape the
 * launcher, the CLI and the GUI do not agree on.
 */

import type { ZodType } from 'zod'

import { validationError } from './errors.js'

export function parse<T>(schema: ZodType<T>, value: unknown, what = 'body'): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw validationError(`Invalid ${what}`, {
      issues: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
  return result.data
}
