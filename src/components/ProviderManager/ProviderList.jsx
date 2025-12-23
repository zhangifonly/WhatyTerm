import React from 'react';
import { useTranslation } from 'react-i18next';
import ProviderCard from './ProviderCard';

/**
 * 供应商列表组件 - 简化版
 */
export default function ProviderList({ providers, appType = 'claude', onSwitch, onDelete, onHealthCheck, socket }) {
  const { t } = useTranslation();
  let providerList = Object.values(providers.providers);

  // 按 sortIndex 排序
  providerList.sort((a, b) => {
    const aIndex = a.sortIndex ?? 999999;
    const bIndex = b.sortIndex ?? 999999;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  if (providerList.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 mb-4">还没有添加供应商</div>
        <div className="text-sm text-gray-500">
          点击上方「预设模板」选项卡，从预设中快速添加供应商
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Cli Only 警告提示 */}
      <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-3">
        <p className="text-red-400 text-sm leading-relaxed">
          {t('provider.cliOnlyWarning')}
        </p>
      </div>

      {/* 供应商列表 */}
      <div className="space-y-3">
        {providerList.map(provider => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            appType={appType}
            isCurrent={providers.current === provider.id}
            onSwitch={onSwitch}
            onDelete={onDelete}
            onHealthCheck={onHealthCheck}
            socket={socket}
          />
        ))}
      </div>
    </div>
  );
}
