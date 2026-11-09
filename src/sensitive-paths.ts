// Directories and file names that commonly hold credentials. Reads that touch
// them always go to review, wherever they sit in the tree.
const SENSITIVE_DIRECTORIES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  "secrets",
  ".secrets",
  "credentials",
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  ".dockercfg",
  ".vault-token",
  "kubeconfig",
]);
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /^(credentials|secrets?)(\.[^.]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)$/,
  /\.tfstate\.backup$/,
];
const NON_SECRET_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

/** Whether a path, relative to the directory being read, looks like it holds credentials. */
export function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter(Boolean).map((segment) => segment.toLowerCase());
  const fileName = segments.at(-1) ?? "";
  if (segments.slice(0, -1).some((segment) => SENSITIVE_DIRECTORIES.has(segment)) || SENSITIVE_DIRECTORIES.has(fileName)) {
    return true;
  }
  if (SENSITIVE_FILE_NAMES.has(fileName)) {
    return true;
  }
  if (fileName.startsWith(".env.") && NON_SECRET_ENV_SUFFIXES.has(fileName.slice(".env.".length))) {
    return false;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}
