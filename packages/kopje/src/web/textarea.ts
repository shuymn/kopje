// A textarea's value from what a browser submits: its line breaks come as CRLF (HTML's form-data newline
// normalization), where the textarea, and the maxlength that bounds it, holds LF; a lone CR reads as LF, as there.
export function textareaText(submitted: string): string {
  return submitted.replace(/\r\n?/g, "\n");
}
