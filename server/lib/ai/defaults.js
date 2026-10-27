// ============================================================
// AI 解析规则的出厂默认值。
// 考核办公室在「解析规则」页调教后的版本存在数据目录 ai-rules.json，
// 这里只在文件不存在、或点「恢复默认」时使用。字段 k 必须和前端 S.w 的键一一对应。
//
// 字段词典每项：
//   k        前端 S.w 的键
//   label    中文名（同时作为首选叫法）
//   type     num | text | bool | enum | table（table 另有 cols：[[键, 列名, 单位]…]，每行一个开次）
//   unit     目标单位（解析结果统一换算到这个单位）
//   aliases  资料里可能出现的其它叫法，排在前面的优先
//   conv     单位换算：资料单位 → 乘以 factor 得到目标单位
//   pick     actual 取实际值 / design 取设计值 / 空 = 不区分
//   note     给大模型看的取值说明
// ============================================================

const H2D = 1 / 24;
const WAN = 10000;

const FIELDS = [
  // —— 基础信息 ——
  { k: 'wellNo', label: '井号', type: 'text', aliases: ['井名', '井号名称'],
    note: '保留原始写法（汉字、数字、字母、连字符），如「板深72-H3」；去掉末尾的「井」字。' },
  { k: 'team', label: '队号', type: 'enum', aliases: ['钻井队', '钻井队号', '施工队伍', '承钻队伍', '施工单位', '井队'],
    note: '只取队号编号，如「渤海钻探第三钻井公司70318钻井队」取 70318。必须是候选队号之一，对不上就不填。' },
  { k: 'wellType', label: '井型', type: 'enum', options: ['定向井', '水平井', '直井'], aliases: ['井身类型', '井眼轨迹类型', '井眼类型'],
    note: '大斜度井、斜井、定向井 → 定向井；水平井、分支水平井 → 水平井；直井、垂直井 → 直井。注意「井别」（探井/开发井）不是井型。' },
  { k: 'block', label: '区块', type: 'text', aliases: ['所属区块', '油田区块', '构造', '构造位置', '开发区块'],
    note: '尽量写成定额库已有区块名。定额库按井深分档的区块（如「板桥（＜3500米）」），按完钻井深选档。' },
  { k: 'phase', label: '开次', type: 'enum', options: [2, 3, 4], aliases: ['开钻次数', '井身结构'],
    note: '二开→2，三开→3，四开→4。按井身结构中的最大开次取。' },
  { k: 'revenue', label: '本井收入', type: 'num', unit: '元', aliases: ['单井收入', '工作量收入', '结算收入', '钻井收入'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },
  { k: 'gmAmount', label: '贡献毛益额', type: 'num', unit: '元', aliases: ['毛益额', '贡献毛益', '单井毛益额'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },

  // —— 工作量与周期 ——
  { k: 'footage', label: '实际进尺', type: 'num', unit: '米', aliases: ['本井进尺', '总进尺', '钻井进尺', '完钻井深', '完井井深', '完钻斜深', '斜深', '实际井深'],
    conv: [{ unit: '千米', factor: 1000 }, { unit: 'km', factor: 1000 }, { unit: 'm', factor: 1 }], pick: 'actual',
    note: '取实际值。新井从地面开钻，进尺 = 完钻井深（斜深 MD）；侧钻、加深井取本次进尺。不能用垂深，也不能用设计井深。' },
  { k: 'preDays', label: '钻前周期', type: 'num', unit: '天', aliases: ['搬安周期', '钻前工程周期', '搬迁安装周期'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },
  { k: 'cycleDays', label: '钻完井周期', type: 'num', unit: '天', aliases: ['钻井完井周期', '实际钻完井周期', '钻完井时间'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual',
    note: '开钻至完井（交井）的实际天数。不是建井周期；见数据理解规则。' },
  { k: 'assessedCycleDays', label: '实际考核钻完井周期', type: 'num', unit: '天', aliases: ['考核钻完井周期', '考核周期', '剔除后钻完井周期'],
    conv: [{ unit: '小时', factor: H2D }], pick: 'actual',
    note: '只有资料明确给出「剔除甲方原因/不可抗力后」的周期才填，否则不填。' },
  { k: 'planDays', label: '策划周期', type: 'num', unit: '天', aliases: ['设计周期', '设计钻完井周期', '设计天数', '计划周期', '策划钻完井周期'],
    conv: [{ unit: '小时', factor: H2D }], pick: 'design',
    note: '取设计/策划值，不取实际值。' },
  { k: 'crewStd', label: '定员标准', type: 'num', unit: '人', aliases: ['定员', '定员人数', '人员定额'],
    note: '资料没写就不填（系统默认 38 人）。' },
  { k: 'testDays', label: '试油/完井天数', type: 'num', unit: '天', aliases: ['试油天数', '完井天数', '试油时间', '完井作业时间', '完井周期'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },
  { k: 'coreDays', label: '取心天数', type: 'num', unit: '天', aliases: ['取心时间', '取芯天数', '取芯时间', '取心作业时间'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },
  { k: 'kickDays', label: '气水侵溢流天数', type: 'num', unit: '天', aliases: ['溢流处理时间', '井控处理时间', '气侵处理时间', '溢流复杂时间'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },
  { k: 'lossDays', label: '井漏/事故复杂天数', type: 'num', unit: '天', aliases: ['井漏处理时间', '复杂处理时间', '事故复杂时间', '复杂损失时间', '事故损失时间'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },
  { k: 'sidetrack', label: '认可侧钻报废进尺', type: 'num', unit: '米', aliases: ['侧钻报废进尺', '报废进尺'], pick: 'actual',
    note: '只取甲方认可的侧钻报废进尺。' },
  { k: 'waitDays', label: '等停天数', type: 'num', unit: '天', aliases: ['等停时间', '甲方原因等停', '停待时间', '等待时间'],
    conv: [{ unit: '小时', factor: H2D }, { unit: 'h', factor: H2D }], pick: 'actual' },

  // —— 难度判定参数 ——
  { k: 'horizLen', label: '水平段长', type: 'num', unit: '米', aliases: ['水平段长度', '水平段进尺', '水平段'], pick: 'actual',
    conv: [{ unit: 'm', factor: 1 }] },
  { k: 'displacement', label: '水平位移', type: 'num', unit: '米', aliases: ['位移', '闭合位移', '完钻位移', '最大位移'], pick: 'actual',
    conv: [{ unit: 'm', factor: 1 }] },
  { k: 'vertDepth', label: '垂深', type: 'num', unit: '米', aliases: ['完钻垂深', '垂直井深', 'TVD'], pick: 'actual',
    conv: [{ unit: 'm', factor: 1 }] },
  { k: 'techCasing', label: '技套下深', type: 'num', unit: '米', aliases: ['技术套管下深', '技术套管', '技套', '中间套管下深'], pick: 'actual',
    conv: [{ unit: 'm', factor: 1 }],
    note: '取下入深度（米），不要取套管尺寸（mm / 英寸）。' },
  { k: 'keyExpl', label: '重点探井', type: 'bool', aliases: ['重点探井'],
    note: '资料明确写明是重点探井时为 true。' },

  // —— 工况开关 ——
  { k: 'winter', label: '冬季施工', type: 'bool', aliases: ['冬季钻井', '冬防保温'],
    note: '资料明确写冬季施工，或工序里有冬防保温时为 true。' },
  { k: 'e2o', label: '电代油', type: 'bool', aliases: ['网电钻机', '网电施工', '电代油钻井队'] },
  { k: 'diesel', label: '柴油动力', type: 'bool', aliases: ['柴油机动力', '柴油发电'],
    note: '全程网电施工时为 false。' },
  { k: 'dayrate', label: '日费井', type: 'bool', aliases: ['日费制', '按日费结算', '日费'] },
  { k: 'dayrateRatio', label: '日费率', type: 'num', unit: '%', aliases: ['日费结算比例'] },
  { k: 'geoMove', label: '土工膜·搬迁', type: 'bool', aliases: ['土工膜搬迁'] },
  { k: 'geoShift', label: '土工膜·平移', type: 'bool', aliases: ['土工膜平移'] },

  // —— 成本实际消耗 ——
  { k: 'matAct', label: '一般材料费', type: 'num', unit: '元', aliases: ['材料费', '一般材料', '材料消耗'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },
  { k: 'repairAct', label: '项修费用', type: 'num', unit: '元', aliases: ['项修费', '项修'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },
  { k: 'elecKwh', label: '网电', type: 'num', unit: '度', aliases: ['网电用量', '用电量', '耗电量', '电量'],
    conv: [{ unit: '万度', factor: WAN }, { unit: '万千瓦时', factor: WAN }, { unit: 'kWh', factor: 1 }, { unit: '千瓦时', factor: 1 }], pick: 'actual' },
  { k: 'dieselTon', label: '柴油', type: 'num', unit: '吨', aliases: ['柴油消耗', '柴油用量', '柴油耗量'],
    conv: [{ unit: '千克', factor: 0.001 }, { unit: 'kg', factor: 0.001 }, { unit: 't', factor: 1 }], pick: 'actual' },
  { k: 'oilTon', label: '机油', type: 'num', unit: '吨', aliases: ['润滑油', '机油消耗', '润滑油消耗'],
    conv: [{ unit: '千克', factor: 0.001 }, { unit: 'kg', factor: 0.001 }, { unit: 't', factor: 1 }], pick: 'actual' },
  { k: 'sewageM3', label: '生活污水', type: 'num', unit: '方', aliases: ['生活污水拉运量', '污水拉运'],
    conv: [{ unit: '立方米', factor: 1 }, { unit: 'm3', factor: 1 }, { unit: 'm³', factor: 1 }], pick: 'actual' },
  { k: 'prodWaterAct', label: '生产水', type: 'num', unit: '元', aliases: ['生产水费用'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },
  { k: 'geoAct', label: '土工膜实际', type: 'num', unit: '元', aliases: ['土工膜费用'],
    conv: [{ unit: '万元', factor: WAN }], pick: 'actual' },

  // —— 专项与扣减 ——
  { k: 'hasAccident', label: '发生事故复杂', type: 'bool', aliases: ['事故复杂', '井下复杂', '井下事故'],
    note: '资料记载本井发生有责事故或井下复杂时为 true；明确写「无事故复杂」时为 false。' },
  { k: 'multiRig', label: '一队多机', type: 'bool', aliases: ['一队多机（跨区域）', '跨区域施工'] },
  { k: 'honorAward', label: '特殊荣誉奖', type: 'num', unit: '元', conv: [{ unit: '万元', factor: WAN }] },
  { k: 'grossMargin', label: '单井毛益率', type: 'num', unit: '%', aliases: ['毛益率'], pick: 'actual' },
  { k: 'qualityDeduct', label: '井筒质量扣款', type: 'num', unit: '元', aliases: ['质量扣款'], conv: [{ unit: '万元', factor: WAN }] },
  { k: 'damageDeduct', label: '工具损毁赔偿', type: 'num', unit: '元', aliases: ['工具损坏赔偿', '损毁赔偿'], conv: [{ unit: '万元', factor: WAN }] },

  // —— 一井一策测算参数（取自钻井工程设计书，一律取设计值）——
  { k: 'designDepth', label: '设计井深', type: 'num', unit: '米', aliases: ['设计完钻井深', '设计斜深', '设计总井深', '设计完钻斜深'], pick: 'design',
    conv: [{ unit: 'm', factor: 1 }],
    note: '设计完钻井深（斜深 MD）。不是垂深，也不是某一开次的井深。' },
  { k: 'designVertDepth', label: '设计垂深', type: 'num', unit: '米', aliases: ['设计完钻垂深', '设计垂直井深', '完钻垂深'], pick: 'design',
    conv: [{ unit: 'm', factor: 1 }] },
  { k: 'designHorizLen', label: '设计水平段长', type: 'num', unit: '米', aliases: ['水平段设计长度', '设计水平段长度', '水平段长'], pick: 'design',
    conv: [{ unit: 'm', factor: 1 }] },
  { k: 'designDisp', label: '设计水平位移', type: 'num', unit: '米', aliases: ['设计位移', '设计闭合位移', '完钻位移', '闭合位移'], pick: 'design',
    conv: [{ unit: 'm', factor: 1 }],
    note: '取完钻（井底）闭合位移，不取某个靶点的位移。' },
  { k: 'designTechCasing', label: '设计技套下深', type: 'num', unit: '米', aliases: ['技术套管设计下深', '技套设计下深', '技术套管下深', '技套下深'], pick: 'design',
    conv: [{ unit: 'm', factor: 1 }],
    note: '取技术套管的设计下入深度（米），不要取套管尺寸；表层套管、油层套管、尾管都不是技术套管。' },
  { k: 'maxIncl', label: '最大井斜', type: 'num', unit: '°', aliases: ['最大井斜角', '设计最大井斜', '最大井斜角度'], pick: 'design',
    conv: [{ unit: '度', factor: 1 }] },
  { k: 'targetFm', label: '目的层', type: 'text', aliases: ['目的层位', '目的层系', '主要目的层', '设计目的层', '钻探目的层'], pick: 'design',
    note: '写层位名称，如「沙三段」「孔二段」；多个目的层用顿号分隔。' },
  { k: 'pressureCoef', label: '地层压力系数', type: 'num', unit: '', aliases: ['压力系数', '地层孔隙压力系数', '预测地层压力系数', '孔隙压力系数'], pick: 'design',
    note: '无量纲，一般在 0.8～2.0 之间。分段给出时取目的层段的值，并在依据里说明。' },
  { k: 'mudDensity', label: '设计钻井液密度', type: 'num', unit: 'g/cm³', aliases: ['钻井液密度', '泥浆密度', '设计泥浆密度'], pick: 'design',
    conv: [{ unit: 'g/cm3', factor: 1 }, { unit: 'kg/m³', factor: 0.001 }, { unit: 'kg/m3', factor: 0.001 }],
    note: '取目的层段（最后一开）的设计钻井液密度；给出范围（如 1.20～1.35）时取上限。' },
  { k: 'rigModel', label: '设计钻机', type: 'enum', options: ['50型', '70型'], aliases: ['钻机型号', '设计钻机型号', '钻机类型', '钻机选型', '钻机'], pick: 'design',
    note: 'ZJ50 系列 → 50型，ZJ70 系列 → 70型；其它型号不填。' },
  { k: 'powerMode', label: '动力方式', type: 'enum', options: ['网电', '柴油', '网电+柴油'], aliases: ['动力类型', '驱动方式', '钻机动力', '动力配置'], pick: 'design',
    note: '电动钻机接网电 → 网电；柴油机驱动或柴油发电 → 柴油；网电为主、柴油备用 → 网电+柴油。' },
  { k: 'designSections', label: '分开次井身结构', type: 'table', aliases: ['井身结构设计', '井身结构', '钻头程序', '套管程序', '分段钻井周期', '钻井周期设计', '机械钻速'], pick: 'design',
    cols: [['phase', '开次', ''], ['from', '井段起', '米'], ['to', '井段止', '米'], ['bit', '钻头尺寸', 'mm'],
      ['casing', '套管下深', '米'], ['rop', '设计机械钻速', 'm/h'], ['days', '分段周期', '天']],
    note: '每个开次一行。开次写 1、2、3…；井段起止和套管下深取米；钻头尺寸取毫米（英寸×25.4）；设计机械钻速取 m/h；分段周期取该开次的设计钻井天数。资料没给的单元格写 null。' }
];

// 行业术语与专有名词。kind：区块 / 井型 / 队号 / 井号 / 缩写 / 其他。
// 标「示例」的条目是预置的参考写法，请考核办公室按实际核实后修改或删除。
const TERMS = [
  { term: '板深、板', kind: '井号', meaning: '井号以「板」开头的一般属板桥区块（示例，请核实）' },
  { term: '枣', kind: '井号', meaning: '井号以「枣」开头的一般属枣园区块（示例，请核实）' },
  { term: '歧', kind: '井号', meaning: '井号以「歧」开头的一般属歧口区块（示例，请核实）' },
  { term: '-H', kind: '井号', meaning: '井号中带「H」（如 板深72-H3）一般表示水平井（示例，请核实）' },
  { term: '队号格式', kind: '队号', meaning: '5 位数字，50 开头为 50 型钻机、70 开头为 70 型钻机；也有带前缀的编号如 BH70302' },
  { term: '大斜度井', kind: '井型', meaning: '按定向井处理' },
  { term: '分支水平井', kind: '井型', meaning: '按水平井处理；属特殊井，一般走一井一策' },
  { term: 'MD', kind: '缩写', meaning: '斜深（测量井深），新井的实际进尺取它' },
  { term: 'TVD', kind: '缩写', meaning: '垂深' },
  { term: 'KOP', kind: '缩写', meaning: '造斜点，不对应任何录入字段' },
  { term: 'NPT', kind: '缩写', meaning: '非生产时间，要按原因拆分到等停、井漏/事故复杂、溢流等字段，不能整体填入某一项' },
  { term: '技套', kind: '缩写', meaning: '技术套管' },
  { term: '表套', kind: '缩写', meaning: '表层套管，不是技术套管，不要填入技套下深' },
  { term: '完钻', kind: '其他', meaning: '钻达设计井深、停止钻进；完井晚于完钻' }
];

// 数据理解规则：自然语言，原样交给大模型。
const RULES = [
  { text: '钻完井周期（cycleDays）= 一开开钻至完井（交井）的实际天数。「钻井周期」通常指开钻至完钻，不含完井作业；资料同时给出钻井周期和完井周期时，钻完井周期 = 两者之和。只有「钻井周期」没有完井周期时，可以把它当钻完井周期填，但置信度不高于 0.6，并在依据里说明。' },
  { text: '「建井周期」包含钻前搬安、钻井、完井全过程，不能直接当钻完井周期。建井周期与钻完井周期同时出现时，两者之差可作为钻前周期（preDays）。' },
  { text: '只有策划周期（planDays）取设计/策划值；进尺、井深、周期、各类天数、成本消耗一律取实际值。设计值和实际值同时出现时取实际值，不要拿设计值顶替。' },
  { text: '同一字段出现多个候选值时，按以下顺序取：完井报告/交井资料的基本数据表 > 正文叙述 > 日报汇总；同一份资料前后不一致时取日期最晚、最终确认的那个。仍无法判断时照样给出最可能的值，置信度降到 0.5 以下，并在依据里列出所有候选值。' },
  { text: '数值一律换算到字段词典规定的单位：万元→元（×10000），小时→天（÷24），万度→度（×10000），千克→吨（÷1000）。输出的 value 是换算后的纯数字，不带单位和千分位逗号。' },
  { text: '资料里找不到的字段不要输出，不要根据常识、定额或其它字段推算。是/否类字段只有资料里有明确文字依据时才输出。' },
  { text: '技套下深取技术套管的下入深度（米），不是套管外径（mm）；表层套管、油层套管、尾管都不是技术套管。' },
  { text: '水平位移、垂深取完钻时（井底）的数据，不取某个测点或靶点的数据。' },
  { text: '一井一策测算参数（设计井深、设计垂深、设计水平段长、设计水平位移、设计技套下深、最大井斜、目的层、地层压力系数、设计钻井液密度、设计钻机、动力方式、分开次井身结构）取自钻井工程设计书，一律取设计值；完井报告里的实际值不要填进这些字段。' }
];

function defaults() {
  return JSON.parse(JSON.stringify({
    version: 1,
    fields: FIELDS.map(f => Object.assign({ enabled: true, aliases: [], conv: [], pick: '', note: '', unit: '' }, f)),
    terms: TERMS,
    rules: RULES.map(r => Object.assign({ enabled: true }, r)),
    examples: [],
    updatedAt: null,
    updatedBy: ''
  }));
}

module.exports = { defaults };
