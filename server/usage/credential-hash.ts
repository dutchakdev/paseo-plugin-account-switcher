import { createHash } from "node:crypto";

export const credentialHash = (source:string,raw:string):string =>
  `present:${createHash("sha256").update(source).update("\0").update(raw).digest("hex")}`;
