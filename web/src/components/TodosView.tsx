import { useEffect, useState } from 'react';
import { api } from '../api';
import { renderMarkdown } from '../markdown';

interface Todo {
  id: string;
  user_id: string;
  title: string;
  data: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  remind_at: string | null;
  recurrence: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
  return `${Math.round(diff / 86400000)}d`;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

export function TodosView() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  // Form state (shared for add & edit)
  const [title, setTitle] = useState('');
  const [data, setData] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [showDuePicker, setShowDuePicker] = useState(false);
  const [showRemindPicker, setShowRemindPicker] = useState(false);

  const load = () => {
    setLoading(true);
    api.getTodos()
      .then(r => { if (r.ok) setTodos(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openAdd = () => {
    setEditingId(null);
    setTitle(''); setData(''); setPriority('medium');
    setDueDate(''); setRemindAt('');
    setShowDuePicker(false); setShowRemindPicker(false);
    setShowDialog(true);
  };

  const openEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setTitle(todo.title);
    setData(todo.data || '');
    setPriority(todo.priority);
    setDueDate(toLocalInput(todo.due_date));
    setRemindAt(toLocalInput(todo.remind_at));
    setShowDuePicker(!!todo.due_date);
    setShowRemindPicker(!!todo.remind_at);
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditingId(null);
  };

  const saveTodo = async () => {
    if (!title.trim()) return;
    if (editingId) {
      // Edit mode
      await api.updateTodo(editingId, {
        title: title.trim(),
        data: data.trim() || null,
        priority,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
        remind_at: remindAt ? new Date(remindAt).toISOString() : null,
      });
    } else {
      // Add mode
      await api.createTodo({
        title: title.trim(),
        data: data.trim() || undefined,
        priority,
        due_date: dueDate ? new Date(dueDate).toISOString() : undefined,
        ...(remindAt ? { remind_at: new Date(remindAt).toISOString() } : {}),
      } as any);
    }
    closeDialog();
    load();
  };

  const toggleStatus = async (todo: Todo) => {
    const next = todo.status === 'done' ? 'pending' : 'done';
    await api.updateTodo(todo.id, { status: next });
    load();
  };

  const remove = async (id: string) => {
    await api.deleteTodo(id);
    load();
  };

  const active = todos.filter(t => t.status !== 'done');
  const completed = todos.filter(t => t.status === 'done');

  return (
    <div className="td-view">
      {/* Header */}
      <div className="td-header">
        <h2 className="td-title">Todos</h2>
        <button className="td-refresh" onClick={load}>
          <span className="mi">refresh</span>
        </button>
      </div>

      {/* Active todos */}
      {loading && todos.length === 0 ? (
        <div className="td-empty">Loading...</div>
      ) : active.length === 0 && !showDialog ? (
        <div className="td-empty-state">
          <span className="mi td-empty-icon">task_alt</span>
          <p className="td-empty-text">All caught up!</p>
        </div>
      ) : (
        <div className="td-list">
          {active.map(todo => (
            <div key={todo.id} className="td-card">
              <div className="td-card-row" onClick={() => setExpandedId(expandedId === todo.id ? null : todo.id)}>
                <button className="td-check" onClick={e => { e.stopPropagation(); toggleStatus(todo); }}>
                  <span className="mi" style={{ fontSize: 24 }}>radio_button_unchecked</span>
                </button>
                <div className="td-card-body">
                  <div className="td-card-title">{todo.title}</div>
                  <div className="td-card-badges">
                    {todo.priority === 'high' && <span className="td-badge td-badge-high">High</span>}
                    {todo.priority === 'low' && <span className="td-badge td-badge-low">Low</span>}
                    {todo.due_date && (
                      <span className="td-badge td-badge-due">
                        <span className="mi" style={{ fontSize: 12 }}>event</span>
                        {fmtDate(todo.due_date)}
                      </span>
                    )}
                    {todo.remind_at && (
                      <span className={`td-badge ${new Date(todo.remind_at) <= new Date() ? 'td-badge-overdue' : 'td-badge-remind-upcoming'}`}>
                        <span className="mi" style={{ fontSize: 12 }}>notifications</span>
                        {fmtRelative(todo.remind_at)}
                      </span>
                    )}
                  </div>
                </div>
                <span className="mi td-chevron">{expandedId === todo.id ? 'expand_less' : 'expand_more'}</span>
              </div>
              {expandedId === todo.id && (
                <div className="td-card-expand">
                  {todo.data && <div className="td-card-notes" dangerouslySetInnerHTML={{ __html: renderMarkdown(todo.data) }} />}
                  <div className="td-card-meta">
                    <span>Added {fmtDate(todo.created_at)} by {todo.created_by}</span>
                  </div>
                  <div className="td-card-actions">
                    <button className="td-action-btn" onClick={() => openEdit(todo)}>
                      <span className="mi" style={{ fontSize: 16 }}>edit</span> Edit
                    </button>
                    <button className="td-action-btn td-action-delete" onClick={() => remove(todo.id)}>
                      <span className="mi" style={{ fontSize: 16 }}>delete</span> Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Completed section */}
      {completed.length > 0 && (
        <div className="td-completed-section">
          <button className="td-completed-toggle" onClick={() => setShowCompleted(!showCompleted)}>
            <span className="mi" style={{ fontSize: 18 }}>{showCompleted ? 'expand_less' : 'expand_more'}</span>
            Completed ({completed.length})
          </button>
          {showCompleted && (
            <div className="td-list">
              {completed.map(todo => (
                <div key={todo.id} className="td-card td-card-done">
                  <div className="td-card-row">
                    <button className="td-check" onClick={() => toggleStatus(todo)}>
                      <span className="mi" style={{ fontSize: 24, color: 'var(--purple)' }}>check_circle</span>
                    </button>
                    <div className="td-card-body">
                      <div className="td-card-title td-done-title">{todo.title}</div>
                    </div>
                    <button className="td-check" onClick={() => remove(todo.id)}>
                      <span className="mi" style={{ fontSize: 18, color: 'var(--text3)' }}>close</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* FAB */}
      <button className="td-fab" onClick={openAdd}>
        <span className="mi" style={{ fontSize: 28 }}>add</span>
      </button>

      {/* Add/Edit dialog */}
      {showDialog && (
        <div className="td-overlay" onClick={e => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div className="td-dialog" onClick={e => e.stopPropagation()}>
            <div className="td-dialog-header">
              <h3>{editingId ? 'Edit Todo' : 'New Todo'}</h3>
              <button className="td-check" onClick={closeDialog}>
                <span className="mi">close</span>
              </button>
            </div>

            <div className="td-dialog-scroll">
              <input
                className="td-dialog-input"
                placeholder="What needs to be done?"
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && saveTodo()}
                autoFocus
              />

              {/* Options row */}
              <div className="td-options">
                <button
                  className={`td-option-chip ${priority === 'high' ? 'td-chip-red' : priority === 'low' ? 'td-chip-green' : 'td-chip-default'}`}
                  onClick={() => setPriority(priority === 'medium' ? 'high' : priority === 'high' ? 'low' : 'medium')}
                >
                  <span className="mi" style={{ fontSize: 16 }}>flag</span>
                  {priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium'}
                </button>

                <button
                  className={`td-option-chip ${dueDate ? 'td-chip-active' : showDuePicker ? 'td-chip-active' : 'td-chip-default'}`}
                  onClick={() => { if (dueDate) { setDueDate(''); setShowDuePicker(false); } else { setShowDuePicker(!showDuePicker); } }}
                >
                  <span className="mi" style={{ fontSize: 16 }}>event</span>
                  {dueDate ? new Date(dueDate).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Due date'}
                  {dueDate && (
                    <span className="td-chip-clear" onClick={e => { e.stopPropagation(); setDueDate(''); setShowDuePicker(false); }}>
                      <span className="mi" style={{ fontSize: 14 }}>close</span>
                    </span>
                  )}
                </button>

                <button
                  className={`td-option-chip ${remindAt ? 'td-chip-active' : showRemindPicker ? 'td-chip-active' : 'td-chip-default'}`}
                  onClick={() => { if (remindAt) { setRemindAt(''); setShowRemindPicker(false); } else { setShowRemindPicker(!showRemindPicker); } }}
                >
                  <span className="mi" style={{ fontSize: 16 }}>notifications</span>
                  {remindAt ? new Date(remindAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Reminder'}
                  {remindAt && (
                    <span className="td-chip-clear" onClick={e => { e.stopPropagation(); setRemindAt(''); setShowRemindPicker(false); }}>
                      <span className="mi" style={{ fontSize: 14 }}>close</span>
                    </span>
                  )}
                </button>
              </div>

              {/* Inline pickers — appear below chips when toggled */}
              {showDuePicker && (
                <input type="datetime-local" className="td-dialog-input td-dialog-input-sm" value={dueDate} onChange={e => setDueDate(e.target.value)} autoFocus />
              )}
              {showRemindPicker && (
                <input type="datetime-local" className="td-dialog-input td-dialog-input-sm" value={remindAt} onChange={e => setRemindAt(e.target.value)} autoFocus />
              )}

              {/* Notes */}
              <textarea
                className="td-dialog-textarea"
                placeholder="Add notes (supports markdown)..."
                value={data}
                onChange={e => setData(e.target.value)}
                rows={2}
              />
            </div>

            {/* Submit */}
            <button className="td-dialog-submit" onClick={saveTodo} disabled={!title.trim()}>
              {editingId ? 'Save Changes' : 'Add Todo'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
