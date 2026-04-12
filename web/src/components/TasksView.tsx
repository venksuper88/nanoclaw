import { useEffect, useState } from 'react';
import { api } from '../api';
import { renderMarkdown } from '../markdown';

interface Task {
  id: string;
  group_folder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}

interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function taskTitle(prompt: string): string {
  const firstLine = prompt.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + '…';
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, TaskRunLog[]>>({});
  const [logsLoading, setLogsLoading] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getTasks().then(r => { if (r.ok) setTasks(r.data); }).catch(() => {}).finally(() => setLoading(false));
  };

  const clearCompleted = async () => {
    const completed = tasks.filter(t => t.status === 'completed');
    if (completed.length === 0) return;
    await Promise.all(completed.map(t => api.deleteTask(t.id)));
    load();
  };

  useEffect(() => { load(); }, []);

  const toggle = async (task: Task) => {
    if (task.status === 'active') {
      await api.pauseTask(task.id);
    } else {
      await api.resumeTask(task.id);
    }
    load();
  };

  const remove = async (task: Task) => {
    if (!confirm(`Delete task "${task.prompt.slice(0, 50)}..."?`)) return;
    await api.deleteTask(task.id);
    load();
  };


  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <h3>Scheduled Tasks</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {tasks.some(t => t.status === 'completed') && (
            <button className="task-toggle task-delete" onClick={clearCompleted}>
              <span className="mi" style={{ fontSize: 18 }}>delete_sweep</span>
              Clear completed
            </button>
          )}
          <button className="overview-refresh" onClick={load}>
            <span className="mi" style={{ fontSize: 18 }}>refresh</span>
          </button>
        </div>
      </div>

      {loading && tasks.length === 0 && (
        <div className="tasks-empty">Loading...</div>
      )}

      {!loading && tasks.length === 0 && (
        <div className="tasks-empty">
          <span className="mi" style={{ fontSize: 40, color: 'var(--text3)' }}>schedule</span>
          <p>No scheduled tasks</p>
        </div>
      )}

      <div className="tasks-list">
        {tasks.map(task => (
          <div key={task.id} className={`task-card ${task.status}`}>
            <div className="task-card-row" onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}>
              <span className={`task-status-dot ${task.status}`} />
              <div className="task-card-title-col">
                <span className="task-title">{taskTitle(task.prompt)}</span>
                <span className="task-subtitle">
                  {task.group_folder} &middot; {task.schedule_type}: {task.schedule_value} &middot; Next: {fmtDate(task.next_run)}
                </span>
              </div>
              <span className="mi task-expand-icon" style={{ fontSize: 20 }}>
                {expandedTask === task.id ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {expandedTask === task.id && (
              <div className="task-expanded">
                <div className="task-prompt">{task.prompt}</div>
                <div className="task-meta">
                  <span>Next: {fmtDate(task.next_run)}</span>
                  <span>Last: {fmtDate(task.last_run)}</span>
                </div>
                {task.last_result && (
                  <div className="task-result" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.last_result.slice(0, 200)) }} />
                )}
                <div className="task-actions">
                  <button className="task-toggle" onClick={() => toggle(task)}>
                    <span className="mi" style={{ fontSize: 18 }}>
                      {task.status === 'active' ? 'pause' : 'play_arrow'}
                    </span>
                    {task.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                  <button className="task-toggle" onClick={() => {
                    if (logs[task.id]) {
                      setLogs(prev => { const next = { ...prev }; delete next[task.id]; return next; });
                    } else {
                      setLogsLoading(task.id);
                      api.getTaskLogs(task.id).then(r => {
                        if (r.ok) setLogs(prev => ({ ...prev, [task.id]: r.data }));
                      }).catch(() => {}).finally(() => setLogsLoading(null));
                    }
                  }}>
                    <span className="mi" style={{ fontSize: 18 }}>history</span>
                    {logs[task.id] ? 'Hide Logs' : 'Logs'}
                  </button>
                  <button className="task-toggle task-delete" onClick={() => remove(task)}>
                    <span className="mi" style={{ fontSize: 18 }}>delete</span>
                    Delete
                  </button>
                </div>

                {logsLoading === task.id && <div className="task-logs"><div className="task-logs-loading">Loading logs...</div></div>}
                {logs[task.id] !== undefined && (
                  <div className="task-logs">
                    {logs[task.id].length === 0 && (
                      <div className="task-logs-empty">No run history yet</div>
                    )}
                    {logs[task.id].length > 0 && (
                      <div className="task-logs-list">
                        {logs[task.id].map((log, i) => (
                          <div key={i} className={`task-log-entry ${log.status}`}>
                            <div className="task-log-header">
                              <span className={`task-log-status ${log.status}`}>
                                <span className="mi" style={{ fontSize: 14 }}>
                                  {log.status === 'success' ? 'check_circle' : 'error'}
                                </span>
                                {log.status}
                              </span>
                              <span className="task-log-time">{fmtDate(log.run_at)}</span>
                              <span className="task-log-duration">{fmtDuration(log.duration_ms)}</span>
                            </div>
                            {log.result && (
                              <div className="task-log-result" dangerouslySetInnerHTML={{ __html: renderMarkdown(log.result) }} />
                            )}
                            {log.error && (
                              <div className="task-log-error">{log.error}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
