interface Props {
  url: string;
  filename: string;
  type: 'image' | 'video' | 'pdf';
  onClose: () => void;
}

export function MediaViewer({ url, filename, type, onClose }: Props) {
  return (
    <div className="media-viewer-overlay" onClick={onClose}>
      <div className="media-viewer-bar">
        <button className="media-viewer-btn" onClick={onClose}>
          <span className="mi">close</span>
        </button>
        <span className="media-viewer-filename">{filename}</span>
      </div>
      <div className="media-viewer-content" onClick={e => e.stopPropagation()}>
        {type === 'image' && (
          <img src={url} alt={filename} />
        )}
        {type === 'video' && (
          <video src={url} controls autoPlay />
        )}
        {type === 'pdf' && (
          <iframe src={url} title={filename} style={{ width: '100%', height: '100%', border: 'none' }} />
        )}
      </div>
    </div>
  );
}
