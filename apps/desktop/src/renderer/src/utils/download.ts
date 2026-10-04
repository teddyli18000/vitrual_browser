/**
 * Handing text to the user's save dialog.
 *
 * Deliberately **not** a `Blob` plus `<a download>`: whether Electron prompts for a location or
 * silently writes into the Downloads folder depends on Chromium's download handling, and a "save"
 * that puts a cookie jar somewhere the user did not choose is worse than no save at all. The
 * `vfox:save-text` capability opens the dialog in the main process — the same shape as the
 * existing `vfox:save-export` — so the destination is chosen by the user and the path is known.
 *
 * Returns the written path, or `null` when the user cancelled. Cancelling is a normal outcome and
 * must never be reported as a failure.
 */
export async function saveTextFile(suggestedName: string, content: string): Promise<string | null> {
  const result = await window.vfox.saveText({ suggestedName, content })
  return result.saved ? result.path : null
}
