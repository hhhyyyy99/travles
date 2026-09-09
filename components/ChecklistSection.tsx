'use client';

import React, { useState, useEffect } from 'react';

const CHECKLIST_ITEMS = [
  '确认林芝取车、贡嘎机场还车',
  '订好 5 处住宿、共 6 晚',
  '确认索松村与结巴村入园接驳',
  '准备证件与保暖衣物',
  '下载离线地图、检查天气路况',
  '确认 10/8 还车接驳',
];

const STORAGE_KEY = 'tibet-slow-trip-checklist-oct7-v2';

export default function ChecklistSection() {
  const [checkedIndices, setCheckedIndices] = useState<number[]>([]);
  const [saveStatus, setSaveStatus] = useState<string>('勾选状态保存在当前浏览器。');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) {
        setCheckedIndices(saved);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleToggle = (index: number) => {
    const next = checkedIndices.includes(index)
      ? checkedIndices.filter((i) => i !== index)
      : [...checkedIndices, index];

    setCheckedIndices(next);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaveStatus('勾选状态保存在当前浏览器。');
    } catch {
      setSaveStatus('当前浏览器未允许保存，勾选仅在本页有效。');
    }
  };

  return (
    <section className="check-section">
      <div className="section-label">
        <h2>我的出发清单</h2>
        <span id="check-count">
          {checkedIndices.length} / {CHECKLIST_ITEMS.length}
        </span>
      </div>
      <div className="checklist" id="checklist">
        {CHECKLIST_ITEMS.map((item, index) => {
          const isChecked = checkedIndices.includes(index);
          return (
            <label key={index}>
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => handleToggle(index)}
              />
              {item}
            </label>
          );
        })}
      </div>
      <p className="fine" id="save-status">
        {saveStatus}
      </p>
    </section>
  );
}
