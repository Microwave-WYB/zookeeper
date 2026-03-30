import { Ok, Error } from "../gleam.mjs";

export function get_env(name) {
  const val = process.env[name];
  if (val !== undefined && val !== "") return new Ok(val);
  return new Error(undefined);
}
