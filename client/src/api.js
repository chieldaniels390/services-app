const TOKEN_KEY = 'pronow.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode etc. - the session just won't survive a reload.
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Sends a file as the raw request body (the server checks its real type from its contents). */
export async function apiUpload(path, file) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream', ...(token && { authorization: `Bearer ${token}` }) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? (res.status === 413 ? 'That file is too large (8 MB max)' : `Upload failed (${res.status})`));
  return data;
}

/** Downloads a protected file (e.g. a verification document) with the auth header img/src can't send. */
export async function apiBlob(path) {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Could not load file (${res.status})`);
  }
  return res.blob();
}

/** Downloads a protected file (e.g. an invoice PDF) and saves it with the given name. */
export async function downloadFile(path, fileName) {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
