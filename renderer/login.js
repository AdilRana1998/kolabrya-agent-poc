'use strict';

const h = React.createElement;

function LoginCard() {
  const [email, setEmail] = React.useState('group_inc_user_2_@mailinator.com');
  const [password, setPassword] = React.useState('12345678@A');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    // If a session is already valid, the main process will have shown the
    // dashboard. But if this window is open, we just need a normal login.
    window.kolabrya.authStatus().then((s) => {
      if (s && s.email) setEmail(s.email);
    }).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await window.kolabrya.login(email, password);
      // main.js will swap windows; nothing more to do here.
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  return h('div', { className: 'login-shell' },
    h('form', { className: 'login-card', onSubmit: submit },
      h('h1', null, 'Kolabrya Agent'),
      h('div', { className: 'sub' }, 'Sign in to continue'),
      h('label', { htmlFor: 'email' }, 'Email'),
      h('input', {
        id: 'email', type: 'email', autoFocus: true, required: true,
        value: email, onChange: (e) => setEmail(e.target.value),
        placeholder: 'you@company.com',
      }),
      h('label', { htmlFor: 'pw' }, 'Password'),
      h('input', {
        id: 'pw', type: 'password', required: true,
        value: password, onChange: (e) => setPassword(e.target.value),
        placeholder: '••••••••',
      }),
      err ? h('div', { className: 'err' }, err) : null,
      h('div', { style: { marginTop: 18 } },
        h('button', {
          type: 'submit', className: 'primary', disabled: busy,
          style: { width: '100%' },
        }, busy ? 'Signing in…' : 'Sign in'),
      ),
      h('div', { className: 'sub', style: { marginTop: 14, fontSize: 11 } },
        'Your token is encrypted with the OS keychain (Electron safeStorage).',
      ),
    ),
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(h(LoginCard));
