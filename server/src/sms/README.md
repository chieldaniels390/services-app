# SMS providers

Every provider is a small adapter with the same shape:

```js
{
  name: 'my-provider',
  async send({ to, body }) {   // to is E.164, e.g. +27821234567
    // ...call the provider's API...
    return { id: 'provider-message-id' };   // throw an Error if it wasn't accepted
  },
}
```

To add one:

1. Create `my-provider.js` here exporting `createMyProvider(settings)` (copy `bulksms.js` as a template).
2. Register it in `index.js` (one line in `PROVIDERS`, plus the env vars it needs in `settingsFromEnv`).
3. Run with `SMS_PROVIDER=my-provider`.

Nothing else in the app knows which provider is in use.
