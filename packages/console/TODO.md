# TODO

- [ ] **Move image uploads to graffiticode-app bucket** — Currently images are stored in `graffiticode.appspot.com` because user auth tokens are from the graffiticode project. To use `graffiticode-app.firebasestorage.app`, need to either: (a) set up cross-project service account access, (b) migrate Firebase Auth to graffiticode-app, or (c) use a server-side upload endpoint that authenticates with graffiticode-app credentials.
