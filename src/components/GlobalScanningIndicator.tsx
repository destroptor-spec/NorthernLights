import React from 'react';
import { X } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { useShallow } from 'zustand/react/shallow';

interface GlobalScanningIndicatorProps {
  onClose: () => void;
}

export const GlobalScanningIndicator: React.FC<GlobalScanningIndicatorProps> = ({ onClose }) => {
  const {
    scanPhase,
    scannedFiles,
    totalFiles,
    activeWorkers,
    activeFiles,
    scanningFile,
  } = usePlayerStore(
    useShallow((state) => ({
      scanPhase: state.scanPhase,
      scannedFiles: state.scannedFiles,
      totalFiles: state.totalFiles,
      activeWorkers: state.activeWorkers,
      activeFiles: state.activeFiles,
      scanningFile: state.scanningFile,
    }))
  );

  const isAnalysis = scanPhase === 'analysis';
  const isMetaOrAnalysis = scanPhase === 'metadata' || scanPhase === 'analysis';

  return (
    <div className="global-scanning-indicator">
      <button className="scanner-hide-btn" onClick={onClose} title="Hide">
        <X size={14} />
      </button>

      <div className="scan-header-row">
        <div className="scanning-spinner" />
        <div className="scan-info-col">
          <div className="scan-title-row">
            <span className="scan-title">
              {isAnalysis ? 'Analyzing Audio...' : 'Scanning Library...'}
            </span>
            <span className={`scan-phase-badge ${isAnalysis ? 'scan-phase-badge--analysis' : 'scan-phase-badge--other'}`}>
              {scanPhase}
            </span>
          </div>

          {isMetaOrAnalysis ? (
            <div className="scan-progress-row">
              <span>{scannedFiles} / {totalFiles} {isAnalysis ? 'tracks' : 'files'}</span>
              <span>{activeWorkers} workers</span>
            </div>
          ) : (
            <div className="scan-walk-status">
              {scanningFile || 'Discovering files...'}
            </div>
          )}
        </div>
      </div>

      {isMetaOrAnalysis && activeFiles.length > 0 && (
        <div className="scan-active-files">
          <div className="scan-active-files-heading">
            {isAnalysis ? 'Currently Analyzing:' : 'Currently Processing:'}
          </div>
          <ul className="scan-active-files-list">
            {activeFiles.slice(0, 10).map((file, i) => (
              <li key={i}>{file}</li>
            ))}
            {activeFiles.length > 10 && (
              <li className="scan-active-files-more">
                ...and {activeFiles.length - 10} more
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};
