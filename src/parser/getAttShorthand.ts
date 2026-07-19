/**
 * Splits a `Fn::GetAtt` dotted-string shorthand (`"Resource.Attr"`, as used
 * by both the YAML `!GetAtt` tag and CFN's long-form
 * `Fn::GetAtt: "Resource.Attr"` string syntax) into its parts.
 *
 * Only the first dot splits resource from attribute — the attribute name
 * itself may contain dots (e.g. a nested stack output like
 * `Nested.Outputs.Value`, which splits into `["Nested", "Outputs.Value"]`).
 * A string with no dot at all is malformed `Fn::GetAtt` usage (an attribute
 * is always required) but is not this function's job to reject — it returns
 * the single part as-is so the caller can decide how to handle it.
 */
export function splitGetAttShorthand(raw: string): string[] {
  const dot = raw.indexOf('.');
  return dot === -1 ? [raw] : [raw.slice(0, dot), raw.slice(dot + 1)];
}
