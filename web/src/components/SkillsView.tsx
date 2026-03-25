import { useEffect, useState } from 'react';
import { api } from '../api';

interface Skill {
  name: string;
  description: string;
  type: string;
  folder: string;
}

const TYPE_ICONS: Record<string, string> = {
  container: 'deployed_code',
  'claude-code': 'code',
};

const TYPE_LABELS: Record<string, string> = {
  container: 'Container',
  'claude-code': 'Claude Code',
};

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSkills()
      .then(r => { if (r.ok) setSkills(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="skills-view">
      <div className="skills-header">
        <h3>Skills</h3>
      </div>

      {loading && skills.length === 0 && (
        <div className="tasks-empty">Loading...</div>
      )}

      {!loading && skills.length === 0 && (
        <div className="tasks-empty">
          <span className="mi" style={{ fontSize: 40, color: 'var(--text3)' }}>extension</span>
          <p>No skills installed</p>
        </div>
      )}

      <div className="skills-list">
        {skills.map(skill => (
          <div key={skill.folder} className="skill-card">
            <div className="skill-icon">
              <span className="mi" style={{ fontSize: 22 }}>{TYPE_ICONS[skill.type] || 'extension'}</span>
            </div>
            <div className="skill-info">
              <div className="skill-name">{skill.name}</div>
              <div className="skill-desc">{skill.description}</div>
              <div className="skill-meta">
                <span className="skill-type-badge">{TYPE_LABELS[skill.type] || skill.type}</span>
                <span className="skill-folder">{skill.folder}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
