import { generateKeyPairSync, createHash } from "node:crypto";

// Generic Ed25519 generator. Private = PKCS#8 DER Base64, Public = SPKI DER Base64,
// Key ID = lowercase hex SHA-256 of the public DER bytes. Nothing is written to disk.
export function generateKeyLines(): string[] {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return [
    `Private Key: ${privateDer.toString("base64")}`,
    `Public Key: ${publicDer.toString("base64")}`,
    `Key ID: ${keyId}`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(generateKeyLines().join("\n") + "\n");
}
