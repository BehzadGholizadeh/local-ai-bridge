import type { ApiInfo, ProviderAction, ProviderId, ProviderStatus, Settings, Theme } from '../../../shared/types';

const STATE_LABEL: Record<ProviderStatus['state'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  busy: 'Answering',
  logged_out: 'Signed out',
  challenge: 'Needs check',
  rate_limited: 'Rate limited',
  error: 'Error',
};

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

interface Props {
  statuses: ProviderStatus[];
  settings: Settings;
  api: ApiInfo;
  onAction: (id: ProviderId, action: ProviderAction) => void;
  onTheme: (theme: Theme) => void;
}

export function ProviderBar({ statuses, settings, api, onAction, onTheme }: Props) {
  return (
    <header className="topbar">
      <div className="providers">
        {statuses
          .filter((s) => settings.enabledProviders[s.id])
          .map((s) => {
            const needsLogin = s.state === 'logged_out' || s.state === 'stopped' || s.state === 'error' || s.guest;
            return (
              <div key={s.id} className={`provider state-${s.state}`} title={s.detail ?? STATE_LABEL[s.state]}>
                <span className="dot" />
                <span className="pname">{s.name}</span>
                <span className="pstate">
                  {STATE_LABEL[s.state]}
                  {s.guest && s.state === 'ready' ? ' (guest)' : ''}
                </span>
                {needsLogin && (
                  <button className="small primary" onClick={() => onAction(s.id, 'login')}>
                    Log in
                  </button>
                )}
                {s.state === 'challenge' || s.state === 'rate_limited' ? (
                  <button className="small primary" onClick={() => onAction(s.id, 'show')}>
                    Show
                  </button>
                ) : (
                  <button className="small" onClick={() => onAction(s.id, 'show')} title="Bring the browser window to the front">
                    Show
                  </button>
                )}
                <button className="small" onClick={() => onAction(s.id, 'hide')} title="Minimize the browser window">
                  Hide
                </button>
                <button className="small" onClick={() => onAction(s.id, 'restart')} title="Restart this browser">
                  ↻
                </button>
              </div>
            );
          })}
      </div>
      <div className="topbar-right">
        <span className={`api-pill ${api.running ? 'on' : 'off'}`} title={api.error ?? api.url}>
          API {api.running ? api.url.replace('http://', '') : 'off'}
        </span>
        <button
          className="ghost theme"
          onClick={() => onTheme(NEXT_THEME[settings.theme])}
          title={`Theme: ${settings.theme} (click to change)`}
        >
          {THEME_ICON[settings.theme]}
        </button>
      </div>
    </header>
  );
}
