import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 数据分析监控策略插件
 * 针对数据分析、机器学习等项目的专业监控策略
 */
class DataAnalysisPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'data-analysis';
    this.name = '数据分析';
    this.description = '数据分析和机器学习项目监控策略，支持数据处理、模型训练、结果分析等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /\.ipynb$|jupyter|notebook/i,
      /pandas|numpy|sklearn|tensorflow|pytorch|keras/i,
      /data.*analysis|machine.*learning|deep.*learning/i,
      /数据分析|机器学习|深度学习|模型训练/
    ];

    // 数据分析阶段
    this.phases = [
      { id: 'exploration', name: '数据探索', priority: 1 },
      { id: 'preprocessing', name: '数据预处理', priority: 2 },
      { id: 'modeling', name: '模型构建', priority: 3 },
      { id: 'training', name: '模型训练', priority: 4 },
      { id: 'evaluation', name: '结果评估', priority: 5 },
      { id: 'visualization', name: '可视化', priority: 6 }
    ];
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 模型训练阶段
    if (/training|epoch|loss|accuracy|训练|迭代/i.test(lastLines) ||
        /Epoch \d+|step \d+|batch \d+/i.test(lastLines)) {
      return 'training';
    }

    // 结果评估阶段
    if (/evaluation|accuracy|precision|recall|f1|auc|评估|准确率/i.test(lastLines) ||
        /confusion matrix|classification report/i.test(lastLines)) {
      return 'evaluation';
    }

    // 可视化阶段
    if (/plot|figure|chart|graph|matplotlib|seaborn|可视化|图表/i.test(lastLines)) {
      return 'visualization';
    }

    // 数据预处理阶段
    if (/preprocessing|cleaning|transform|normalize|标准化|清洗|预处理/i.test(lastLines) ||
        /fillna|dropna|encode|scale/i.test(lastLines)) {
      return 'preprocessing';
    }

    // 模型构建阶段
    if (/model|layer|network|架构|模型|网络/i.test(lastLines) ||
        /Sequential|Dense|Conv|LSTM|Transformer/i.test(lastLines)) {
      return 'modeling';
    }

    // 默认为数据探索阶段
    return 'exploration';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const configs = {
      exploration: {
        autoActions: ['继续', '查看数据统计', '检查数据质量'],
        checkpoints: [
          '数据规模是否合适',
          '是否有缺失值',
          '数据分布是否正常',
          '是否有异常值'
        ],
        warningPatterns: [/missing|缺失|异常值|outlier/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      preprocessing: {
        autoActions: ['继续', '处理缺失值', '特征工程'],
        checkpoints: [
          '缺失值是否处理',
          '数据类型是否正确',
          '特征是否标准化',
          '是否有数据泄露'
        ],
        warningPatterns: [/error|warning|数据泄露|data leakage/i],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      modeling: {
        autoActions: ['继续', '调整模型结构', '添加层'],
        checkpoints: [
          '模型结构是否合理',
          '参数量是否适中',
          '是否有过拟合风险',
          '是否选择合适的损失函数'
        ],
        warningPatterns: [/error|模型过大|参数过多/i],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      training: {
        autoActions: ['等待训练完成', '查看训练日志'],
        checkpoints: [
          '损失是否下降',
          '是否有过拟合',
          '训练是否稳定',
          '是否需要早停'
        ],
        warningPatterns: [
          /nan|inf|梯度爆炸|gradient explosion/i,
          /overfitting|过拟合/i
        ],
        autoActionEnabled: false,
        idleTimeout: 600000
      },

      evaluation: {
        autoActions: ['继续', '查看详细指标', '分析错误样本'],
        checkpoints: [
          '指标是否达标',
          '是否有偏差',
          '泛化能力如何',
          '是否需要调优'
        ],
        warningPatterns: [/accuracy.*低|性能不佳|poor performance/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      visualization: {
        autoActions: ['继续', '保存图表', '调整样式'],
        checkpoints: [
          '图表是否清晰',
          '标签是否完整',
          '颜色是否合适',
          '是否需要添加注释'
        ],
        warningPatterns: [/figure.*error|图表错误/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      }
    };

    const config = configs[phase] || configs.exploration;

    // 从文件加载提示词模板
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';

    return {
      ...config,
      promptTemplate
    };
  }

  /**
   * 分析终端状态
   */
  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    // 训练阶段特殊处理
    if (phase === 'training') {
      // 检测训练进行中
      if (/Epoch \d+|step \d+|loss.*\d+\.\d+/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'running',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '模型训练进行中...'
        };
      }

      // 检测训练完成
      if (/training.*complete|训练完成|finished/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'success',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '模型训练完成'
        };
      }

      // 检测训练问题
      if (/nan|inf|梯度爆炸/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到训练问题（NaN/Inf），需要人工处理',
          requireConfirmation: true
        };
      }
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检测到潜在问题，建议检查',
          phase,
          phaseConfig: config
        };
      }
    }

    // 检查空闲状态
    if (config.autoActionEnabled && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0],
        phase,
        phaseConfig: config,
        message: `数据分析 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  /**
   * 检测是否空闲（重写以支持 Jupyter 等环境）
   */
  isIdle(terminalContent) {
    const lastLines = terminalContent.split('\n').slice(-10).join('\n');

    // Jupyter/IPython 提示符
    if (/In \[\d+\]:\s*$/.test(lastLines)) {
      return true;
    }

    // Python REPL
    if (/>>>\s*$/.test(lastLines)) {
      return true;
    }

    // 通用空闲检测
    return super.isIdle(terminalContent);
  }
}

export default DataAnalysisPlugin;
