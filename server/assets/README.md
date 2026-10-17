# Customer artwork

`gyermelyi.png` is the unchanged 512×512 icon supplied by the operator:
https://gyermelyi.hu/app/uploads/sites/4/2024/04/cropped-favikon.png

It is packaged locally, not fetched by browsers. Only deployments whose configured
`CURSUS_TENANT_NAME` equals `Gyermelyi` (case-insensitive, trimmed) display it on
the login and magic-link confirmation screens. Other workspaces stay generic.
The name and artwork are intentionally public deployment branding; no tenant IDs,
allowlists, user identities or private customer records are exposed. This is not
a tenant selector and has no effect on authentication or authorization.
