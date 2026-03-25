import { useEffect, useState } from 'react';
import { api } from '../api';

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

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getTasks().then(r => { if (r.ok) setTasks(r.data); }).catch(() => {}).finally(() => setLoading(false));
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

  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <h3>Scheduled Tasks</h3>
        <button className="overview-refresh" onClick={load}>
          <span className="mi" style={{ fontSize: 18 }}>refresh</span>
        </button>
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
            <div className="task-card-header">
              <span className={`task-status-dot ${task.status}`} />
              <span className="task-group">{task.group_folder}</span>
              <span className="task-schedule">{task.schedule_type}: {task.schedule_value}</span>
            </div>
            <div className="task-prompt">{task.prompt}</div>
            <div className="task-meta">
              <span>Next: {fmtDate(task.next_run)}</span>
              <span>Last: {fmtDate(task.last_run)}</span>
            </div>
            {task.last_result && (
              <div className="task-result">{task.last_result.slice(0, 200)}</div>
            )}
            <div className="task-actions">
              <button className="task-toggle" onClick={() => toggle(task)}>
                <span className="mi" style={{ fontSize: 18 }}>
                  {task.status === 'active' ? 'pause' : 'play_arrow'}
                </span>
                {task.status === 'active' ? 'Pause' : 'Resume'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
