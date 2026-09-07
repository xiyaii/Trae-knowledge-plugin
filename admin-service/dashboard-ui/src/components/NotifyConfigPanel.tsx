import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, NotifyConfig, UserInfo } from '../api';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

interface AtUser {
  openId: string;
  name: string;
}

function parseAtUsers(s: string): AtUser[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((item) => {
      const [openId, name = ''] = item.split('|');
      return { openId: openId.trim(), name: name.trim() };
    })
    .filter((u) => u.openId);
}

function serializeAtUsers(users: AtUser[]): string {
  return users.map((u) => (u.name ? `${u.openId}|${u.name}` : u.openId)).join(',');
}

function parseWeekdays(s: string): number[] {
  return s
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => n >= 1 && n <= 7);
}

export function NotifyConfigPanel({
  open,
  onClose,
  me,
}: {
  open: boolean;
  onClose: () => void;
  me: UserInfo | null;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [notifyTime, setNotifyTime] = useState('10:00');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [atUsers, setAtUsers] = useState<AtUser[]>([]);
  const [manualOpenId, setManualOpenId] = useState('');
  const [dashboardUrl, setDashboardUrl] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [lastSentDate, setLastSentDate] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setOkMsg(null);
    api
      .getNotifyConfig()
      .then((cfg: NotifyConfig) => {
        setEnabled(cfg.enabled);
        setNotifyTime(cfg.notify_time || '10:00');
        setWeekdays(parseWeekdays(cfg.notify_weekdays));
        setAtUsers(parseAtUsers(cfg.at_users));
        setDashboardUrl(cfg.dashboard_url);
        setWebhookUrl(cfg.webhook_url);
        setWebhookSecret(cfg.webhook_secret);
        setLastSentDate(cfg.last_sent_date);
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  const addMe = () => {
    if (!me?.open_id) {
      setError('未获取到当前用户 open_id，请重新登录后重试，或手动粘贴');
      return;
    }
    if (atUsers.some((u) => u.openId === me.open_id)) return;
    setAtUsers((prev) => [...prev, { openId: me.open_id!, name: me.name || '' }]);
  };

  const addManual = () => {
    const id = manualOpenId.trim();
    if (!id) return;
    if (!atUsers.some((u) => u.openId === id)) {
      setAtUsers((prev) => [...prev, { openId: id, name: '' }]);
    }
    setManualOpenId('');
  };

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
    );
  };

  const buildConfig = (): NotifyConfig => ({
    enabled,
    webhook_url: webhookUrl.trim(),
    webhook_secret: webhookSecret.trim(),
    notify_time: notifyTime,
    notify_weekdays: weekdays.join(','),
    at_users: serializeAtUsers(atUsers),
    dashboard_url: dashboardUrl.trim(),
    last_sent_date: lastSentDate,
  });

  const save = async () => {
    if (enabled && !webhookUrl.trim()) {
      setError('启用前需填写 Webhook URL');
      return;
    }
    if (enabled && weekdays.length === 0) {
      setError('请至少选择一个发送日');
      return;
    }
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      await api.saveNotifyConfig(buildConfig());
      setOkMsg('已保存');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setOkMsg(null);
    try {
      await api.testNotify();
      setOkMsg('测试消息已发送，请到飞书群查看');
    } catch (e: any) {
      setError(`发送失败：${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="drawer-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="notify-drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <h3>定时通知设置</h3>
              <button className="drawer-close" onClick={onClose}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {loading ? (
                <div className="text-muted" style={{ padding: '32px 0', textAlign: 'center' }}>
                  加载中…
                </div>
              ) : (
                <>
                  {error && (
                    <div className="error-banner" style={{ marginBottom: 12 }}>
                      <span>{error}</span>
                      <button onClick={() => setError(null)}>关闭</button>
                    </div>
                  )}
                  {okMsg && (
                    <div className="notify-ok-banner">{okMsg}</div>
                  )}

                  <div className="notify-field">
                    <div className="notify-field-label">定时通知</div>
                    <label className="notify-switch">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                      />
                      <span className="notify-switch-slider" />
                      <span className="notify-switch-text">{enabled ? '已启用' : '未启用'}</span>
                    </label>
                  </div>

                  <div className="notify-field">
                    <div className="notify-field-label">发送时间</div>
                    <div className="notify-inline">
                      <input
                        type="time"
                        className="notify-input notify-time"
                        value={notifyTime}
                        onChange={(e) => setNotifyTime(e.target.value)}
                      />
                      <span className="text-muted">每日一次（本地时区）</span>
                    </div>
                  </div>

                  <div className="notify-field">
                    <div className="notify-field-label">发送日</div>
                    <div className="weekday-chips">
                      {WEEKDAYS.map((label, i) => {
                        const d = i + 1;
                        const active = weekdays.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            className={`weekday-chip${active ? ' active' : ''}`}
                            onClick={() => toggleWeekday(d)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="notify-field">
                    <div className="notify-field-label">通知@的人</div>
                    <div className="at-user-list">
                      {atUsers.map((u) => (
                        <span key={u.openId} className="at-user-tag" title={u.openId}>
                          {u.name || u.openId}
                          <button
                            type="button"
                            onClick={() => setAtUsers((prev) => prev.filter((x) => x.openId !== u.openId))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {me?.open_id && (
                        <button type="button" className="at-add-me" onClick={addMe}>
                          + 添加我
                        </button>
                      )}
                    </div>
                    <div className="notify-inline" style={{ marginTop: 8 }}>
                      <input
                        type="text"
                        className="notify-input"
                        placeholder="粘贴他人 open_id（ou_ 开头）后回车"
                        value={manualOpenId}
                        onChange={(e) => setManualOpenId(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addManual();
                          }
                        }}
                      />
                      <button type="button" className="notify-secondary-btn" onClick={addManual}>
                        添加
                      </button>
                    </div>
                    <div className="notify-hint">被@的人需在通知群内，否则@不生效</div>
                  </div>

                  <div className="notify-field">
                    <div className="notify-field-label">处理入口链接</div>
                    <input
                      type="text"
                      className="notify-input"
                      placeholder="https://…/dashboard（随通知附带，供跳转处理）"
                      value={dashboardUrl}
                      onChange={(e) => setDashboardUrl(e.target.value)}
                    />
                  </div>

                  <div className="notify-divider" />
                  <div className="notify-field-label">Webhook 设置</div>

                  <div className="notify-field">
                    <div className="notify-field-label">URL</div>
                    <input
                      type="text"
                      className="notify-input"
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                    />
                  </div>

                  <div className="notify-field">
                    <div className="notify-field-label">签名 Secret</div>
                    <input
                      type="password"
                      className="notify-input"
                      placeholder="群机器人安全策略选「签名校验」时的 secret，可留空"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                    />
                  </div>

                  <div className="notify-actions">
                    <button
                      type="button"
                      className="notify-secondary-btn"
                      disabled={testing}
                      title="使用已保存的配置立即发送一条真实通知"
                      onClick={test}
                    >
                      {testing ? '发送中…' : '发送测试通知'}
                    </button>
                    <button
                      type="button"
                      className="notify-primary-btn"
                      disabled={saving}
                      onClick={save}
                    >
                      {saving ? '保存中…' : '保存'}
                    </button>
                  </div>

                  {lastSentDate && (
                    <div className="notify-hint" style={{ textAlign: 'center' }}>
                      上次发送：{lastSentDate}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}