export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const conflict = (message) => new HttpError(409, message);
