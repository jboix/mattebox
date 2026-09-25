/** URL resolution shared by the manifest parsers and the stages that read files. */

/** A URI made absolute against the document that carried it; an unparsable one stays as written. */
export function resolveUrl(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}
