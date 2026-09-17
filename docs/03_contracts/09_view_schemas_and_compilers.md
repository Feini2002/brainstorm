# 三个视图的输入契约、编译器与追溯


## 1. Graph 内容

GraphView.content = {positions:{[itemId]:{x,y}},direction:'LR'|'TB',viewport?:{x,y,zoom}}。坐标必须是有限数，限制绝对值不超过一千万，zoom在0.05到10之间。位置只针对当前实际存在的Item ID；多余位置键读取时忽略或在显式保存时清理，不能产生新的知识节点。View可以保存过滤器与最后一次来源快照，但真正节点文字每次从知识库读取。

图谱初始加载先查询GraphData，再合并已有positions；全部没有坐标时运行一次Dagre，有部分新节点时仅把新节点布局到安全空白区或提示用户自动重排。不要每次filter变化都覆盖所有手工位置。Auto Layout是用户明确动作，结果保存前可以看到变化。

Dagre输入使用节点实际/约定宽高和关系方向，输出中心坐标；React Flow position是左上角，必须减去一半宽高。位置尺寸变化较大时重新布局由用户触发，不能因为标题换行造成无限measure-layout-render循环。

## 2. Mindmap AST

Mindmap content = {title,nodes:[{id,parentId,label,itemIds,kind}]}。id是本视图内部标识，与知识UUID不同。parentId为null的节点恰好一个；所有其他parentId必须存在；节点不得指向自己；从根DFS必须能访问全部节点，发现环或孤岛即拒绝。最多120个节点，根深度1，总深度最大5。

kind只有group、note。group允许汇总多个来源，但不得携带模型凭空创造的事实；note必须至少一个有效来源。叶子不得为空来源，group.itemIds由服务器重新计算为子树来源并与模型值比较，避免模型在根挂上未实际使用的“假引用”。重复同一来源出现在不同分支允许，因为这是不同观察角度，不是重复知识实体。

title≤100、label≤100码点，控制字符除正常空格换行外拒绝或规范为安全空格。Markdown编译器只输出受限标题/缩进列表结构，对反引号、方括号、尖括号、括号、感叹号、井号等保留字符转义。模型不会提供Markdown源码、链接或HTML；服务器不接受“已经生成的SVG”绕过AST校验。

为避免依赖未验证的源码映射，MVP来源点击由React旁边的同树Outline实现，使用AST节点id与itemIds回跳真实笔记。Markmap用于缩放折叠的可视化，来源Outline是可访问且可靠的第二入口。后续若给SVG节点加点击，必须在锁定版本验证安全DOM绑定，不通过标签塞onclick。

## 3. Flow AST

Flow content = {title,direction,nodes:[{id,label,itemIds}],edges:[{source,target,kind,label,itemIds,relationIds,basis?}] }。节点最多40，边最多80，最多40个选中来源。节点id唯一，边端点存在，self-edge默认禁止；同一source/target/kind/label重复边去重。允许环，因为流程可能描述循环，但视觉上应能布局，不把流程当必须无环的脑图。`basis` 由服务端写入，区分 relation / material / inference；模型不得自行声称依据。旧图可以没有该字段，打开时按历史生成显示，不自动付费重算。

编译时把模型内部id映射为程序生成的N0、N1等安全ID，不能把原id原样拼成Mermaid标识。label作为数据转义，禁止提供任意Mermaid指令。direction只允许LR/TB。hypothesis使用明确的“推测：”文字与虚线边，不单靠颜色；causal 按已确认关系或材料表述区分，图例写明依据。

Mermaid源码只由程序模板构造，起始为flowchart LR或TB。不允许click、init、classDef、style、linkStyle、subgraph自定义语法、外链、HTML标签或脚本。要显示某个包含这些单词的普通中文句子时，它仍是被转义的标签，不用粗暴黑名单把正常词全部删掉；核心是语法结构只由编译器控制。

## 4. 编译与渲染责任不同

领域验证器负责图结构、来源和上限；编译器负责把合法数据变成受限语法；渲染器负责把语法画出来；净化器负责输出DOM安全。这四步不能合成一个“把LLM字符串innerHTML”的函数。任何一层失败，UI显示安全错误和可读文本替代，不清空旧视图。

Markmap Transformer生成的节点内容也需要净化，且不调用自动loadJS/loadCSS加载模型触发的插件资源。只使用安装到本地依赖树的核心功能。Mermaid初始化用strict、startOnLoad:false并关闭HTML标签能力；具体配置名以锁定版本文档和测试确认。渲染后的SVG使用DOMPurify SVG允许配置，禁止脚本、foreignObject和事件处理器；若净化破坏所需文字，先调整安全允许集并测试，不直接关闭净化。

所有渲染容器明确宽高。React Strict Mode重复挂载不能重复留下SVG、事件或ResizeObserver；effect返回清理函数，实例存ref，不存全局DOM对象。异步Mermaid渲染分配renderSequence，返回时若不是当前序号或已卸载则丢弃，防止旧请求覆盖新图。实例ID每次唯一，不能多张图都叫graph1。

## 5. 来源快照与过期

生成前在同一数据库读取快照中抓取全部选中Item版本与被用Relation版本。保存View时再次对比版本；不同则Run conflict，旧View仍存在。之后用户再打开时计算isStale/missingSources。展示“基于旧版本”的理由，如哪条笔记revision从3变4，不把所有变化都写成笼统的加载失败。

改图名称、展开节点、缩放和拖动不触发模型，也不改变generatedAt。新生成总是新View；改名和Graph布局使用CAS。没有反向编辑知识库功能：Markmap折叠不等于删除Item，Mermaid源码导出不等于用户可以把编辑后的任意源码导入运行。

## 6. 导出范围

JSON是可机器读取的完整视图说明，包含canonical content与来源ID版本。Markdown和Mermaid是展示衍生物，附生成时间和来源清单的注释或旁边文本，不包含Key或完整请求。导出文件名由viewId和安全日期构造，不使用未经清洗的title直接成为路径。

可选SVG只有在相同净化和浏览器验证通过时开放；本方案不要求PNG/PDF。把可选能力留到MVP之后不影响核心闭环；不要为了漂亮下载按钮引入浏览器截图服务器、图片渲染服务或Python依赖。
