'use client';

import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface AMapDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (key: string, securityJsCode: string) => void;
  isConnected: boolean;
}

export default function AMapDialog({
  isOpen,
  onClose,
  onConnect,
  isConnected,
}: AMapDialogProps) {
  const [key, setKey] = useState('');
  const [securityJsCode, setSecurityJsCode] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    // Check if env variables are defined
    const envKey = process.env.NEXT_PUBLIC_AMAP_KEY;
    const envSec = process.env.NEXT_PUBLIC_AMAP_SECURITY_JS_CODE;
    if (envKey && envKey !== 'your_amap_web_js_api_key') {
      setKey(envKey);
    }
    if (envSec && envSec !== 'your_amap_security_js_code') {
      setSecurityJsCode(envSec);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim() || !securityJsCode.trim()) {
      setStatus('请同时输入 JS API Key 和 安全密钥。');
      return;
    }
    onConnect(key.trim(), securityJsCode.trim());
    onClose();
  };

  if (!isOpen) return null;

  return (
    <dialog
      id="amap-dialog"
      open
      aria-labelledby="amap-dialog-title"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 1000,
        margin: 0,
      }}
    >
      <form id="amap-form" onSubmit={handleSubmit}>
        <div className="dialog-heading">
          <h2 id="amap-dialog-title">连接高德地图</h2>
          <button
            type="button"
            id="amap-close"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <p>
          填写高德开放平台「Web端（JS API）」凭据。输入仅在当前标签页生效，亦可通过
          .env.local 持久化配置。
        </p>

        <label>
          JS API Key
          <input
            id="amap-key"
            type="password"
            autoComplete="off"
            required
            spellCheck="false"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>

        <label>
          安全密钥 securityJsCode
          <input
            id="amap-security"
            type="password"
            autoComplete="off"
            required
            spellCheck="false"
            value={securityJsCode}
            onChange={(e) => setSecurityJsCode(e.target.value)}
          />
        </label>

        {isConnected && (
          <p id="amap-form-status" role="status" style={{ color: '#236a51' }}>
            当前已连接高德地图。重新连接前请刷新页面。
          </p>
        )}
        {status && (
          <p id="amap-form-status" role="status" style={{ color: '#b75342' }}>
            {status}
          </p>
        )}

        <div className="dialog-actions">
          <a
            href="https://console.amap.com/dev/key/app"
            target="_blank"
            rel="noopener noreferrer"
          >
            申请 Key
          </a>
          <button type="submit" id="amap-connect">
            连接地图
          </button>
        </div>
      </form>
    </dialog>
  );
}
