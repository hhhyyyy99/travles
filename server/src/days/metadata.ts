import { DaySchema, type Day } from '@hailar/domain'

/** Day metadata follows the shared contract and preserves raw text, including ''. */
export const DayMetadataSchema = DaySchema.pick({ title: true, note: true })
export type DayMetadata = Pick<Day, 'title' | 'note'>
export type DayMetadataInput = { [K in keyof DayMetadata]?: unknown }

/** Missing, NULL, or corrupt metadata is omitted independently of the other field. */
export function readDayMetadata(row: DayMetadataInput | null | undefined): DayMetadata {
  return {
    ...(typeof row?.title === 'string' ? { title: row.title } : {}),
    ...(typeof row?.note === 'string' ? { note: row.note } : {}),
  }
}
