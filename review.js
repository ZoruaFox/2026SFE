const { Mwn } = require('mwn');
const fs = require('fs');
const config = require('./config');
const utils = require('./utils');
const pc = require('picocolors');
const { spawn } = require('child_process');
const path = require('path');

async function getOAuth2Token() {
    // MediaWiki OAuth 2.0 Client Credentials Grant
    // Token endpoint usually: /w/rest.php/oauth2/access_token
    const tokenUrl = config.apiUrl.replace('api.php', 'rest.php/oauth2/access_token');
    
    console.log(pc.cyan(`[INFO] 获取 OAuth 2.0 令牌... (${tokenUrl})`));
    
    try {
        // Use global fetch (Node 18+)
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': config.userAgent
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: config.oauth2.clientId,
                client_secret: config.oauth2.clientSecret
            })
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`OAuth2 Token fetch failed: ${response.status} ${body}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (e) {
        console.error(pc.red('[FATAL] 无法获取 OAuth 2.0 令牌'), e);
        process.exit(1);
    }
}

/**
 * 更新单个页面的内容
 */
async function updatePageContent(bot, pageTitle, updatedItems, summary) {
    try {
        // 先读取页面当前内容
        const content = await bot.read(pageTitle);
        const wikitext = content.revisions[0].content;
        
        // 应用更新到页面内容
        const updatedWikitext = utils.updatePageContentWithTemplates(wikitext, updatedItems);
        
        // 保存更新后的内容
        await bot.save(pageTitle, updatedWikitext, summary);
        console.log(pc.green(`[SUCCESS] 页面已更新: ${pageTitle}`));
        return true;
    } catch (err) {
        console.error(pc.red(`[ERROR] 更新页面失败 ${pageTitle}:`), err);
        return false;
    }
}

/**
 * 从API获取所有贡献页面
 */
async function getAllContributionPages(bot) {
    const prefix = 'Qiuwen:2026年春节编辑松/提交/';
    const pages = await bot.request({
        action: 'query',
        list: 'allpages',
        apprefix: '2026年春节编辑松/提交/',
        apnamespace: 4, // 4 代表 Project 命名空间 (即 Qiuwen:)
        aplimit: 'max',
        apfilterredir: 'nonredirects' // 仅获取非重定向页面，防止处理已移动留下的重定向页
    }).then(data => data.query.allpages);

    return pages.filter(page => page.title.endsWith('的贡献'));
}

/**
 * 查找所有待审核的项目并保存到JSON文件
 */
async function findPendingReviews(bot) {
    const pages = await getAllContributionPages(bot);
    const pendingData = [];

    for (const page of pages) {
        const username = page.title.replace('Qiuwen:2026年春节编辑松/提交/', '').replace('的贡献', '');
        console.log(pc.dim(`[INFO] 正在处理用户: ${username}...`));

        try {
            const content = await bot.read(page.title);
            const wikitext = content.revisions[0].content;
            
            const result = utils.parseContributionPageWithDetails(wikitext);
            const pendingItems = result.items.filter(item =>
                ['pending', '待审核', 'doing', '审核中'].includes(item.status.toLowerCase())
            );

            for (const item of pendingItems) {
                pendingData.push({
                    page: page.title,
                    user: username,
                    originalLine: item.originalLine,
                    entryName: item.entryName, // 添加条目名称
                    status: item.status,
                    score: item.score,
                    absolutePosition: item.absolutePosition,
                    relativePosition: item.relativePosition,
                    lineNumber: item.lineNumber,
                    templateIndex: item.templateIndex,
                    originalTemplate: item.originalTemplate
                });
            }
        } catch (err) {
            console.error(pc.red(`[ERROR] 处理页面 ${page.title} 时出错:`), err);
        }
    }

    // 保存待审核数据到JSON文件
    fs.writeFileSync('pending_data.json', JSON.stringify(pendingData, null, 2), 'utf8');
    console.log(pc.green(`[SUCCESS] 已将 ${pendingData.length} 个待审核项目保存到 pending_data.json 文件`));

    return pendingData;
}

/**
 * 从JSON文件读取更新数据并更新页面
 */
async function updatePagesFromJson(bot) {
    if (!fs.existsSync('updated_pages.json')) {
        console.error(pc.red('[ERROR] 未找到 updated_pages.json 文件'));
        return false;
    }

    const updatedPages = JSON.parse(fs.readFileSync('updated_pages.json', 'utf8'));
    
    for (const pageData of updatedPages) {
        console.log(pc.cyan(`[INFO] 正在更新页面: ${pageData.title}`));
        await updatePageContent(
            bot, 
            pageData.title, 
            pageData.items, 
            pageData.summary || '快速审核（2026年春节编辑松小工具）'
        );
    }
    
    console.log(pc.green('[SUCCESS] 所有页面更新完成'));
    return true;
}

/**
 * 自动打开浏览器并启动审核流程
 */
async function startReviewProcess() {
    const accessToken = config.oauth2.accessToken || await getOAuth2Token();

    const bot = new Mwn({
        apiUrl: config.apiUrl,
        userAgent: config.userAgent,
        defaultParams: {
            assert: 'user', // 强制要求登录状态
            maxlag: 5 
        }
    });

    const originalRequest = bot.request;
    bot.request = async function(params) {
        // 确保headers中的Authorization值只包含ASCII字符
        if(this.requestOptions.headers && this.requestOptions.headers.Authorization) {
            const authHeader = this.requestOptions.headers.Authorization;
            const cleanAuthHeader = authHeader.split('').filter(char => 
                char.charCodeAt(0) <= 255
            ).join('');
            this.requestOptions.headers.Authorization = cleanAuthHeader;
        }
        return originalRequest.call(this, params);
    };

    bot.requestOptions.headers = {
        ...bot.requestOptions.headers,
        'Authorization': `Bearer ${accessToken}`
    };

    try {
        console.log(pc.blue('[INFO] 验证登录状态并获取编辑令牌...'));
        await bot.getTokens();
        
        const user = await bot.userinfo();
        console.log(pc.green(`[INFO] 登录成功，当前身份: ${user.name}`));

        // 查找待审核项目
        await findPendingReviews(bot);

        // 启动审核页面
        console.log(pc.cyan('[INFO] 启动审核页面...'));
        
        // 尝试打开浏览器
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        const child = spawn(openCmd, ['review.html'], { shell: true });
        
        child.on('error', (err) => {
            console.log(pc.yellow('[WARN] 自动打开浏览器失败，手动打开 review.html 文件'));
            console.log(pc.cyan('提示: 请手动打开 review.html 文件进行审核，完成后运行 "node review.js --finish-review" 完成更新'));
        });

        console.log(pc.green('[SUCCESS] 审核页面已启动，请完成审核后再次运行 "node review.js --finish-review" 完成更新'));
        
    } catch (e) {
        console.error(pc.red('[FATAL] 初始化失败或认证无效:'), e);
        process.exit(1);
    }
}

/**
 * 完成审核并更新页面
 */
async function finishReviewProcess() {
    const accessToken = config.oauth2.accessToken || await getOAuth2Token();

    const bot = new Mwn({
        apiUrl: config.apiUrl,
        userAgent: config.userAgent,
        defaultParams: {
            assert: 'user', // 强制要求登录状态
            maxlag: 5 
        }
    });

    const originalRequest = bot.request;
    bot.request = async function(params) {
        // 确保headers中的Authorization值只包含ASCII字符
        if(this.requestOptions.headers && this.requestOptions.headers.Authorization) {
            const authHeader = this.requestOptions.headers.Authorization;
            const cleanAuthHeader = authHeader.split('').filter(char => 
                char.charCodeAt(0) <= 255
            ).join('');
            this.requestOptions.headers.Authorization = cleanAuthHeader;
        }
        return originalRequest.call(this, params);
    };

    bot.requestOptions.headers = {
        ...bot.requestOptions.headers,
        'Authorization': `Bearer ${accessToken}`
    };

    try {
        console.log(pc.blue('[INFO] 验证登录状态并获取编辑令牌...'));
        await bot.getTokens();
        
        const user = await bot.userinfo();
        console.log(pc.green(`[INFO] 登录成功，当前身份: ${user.name}`));

        // 从JSON文件更新页面
        await updatePagesFromJson(bot);
        
        // 删除临时文件
        if (fs.existsSync('updated_pages.json')) {
            fs.unlinkSync('updated_pages.json');
            console.log(pc.cyan('[INFO] 已删除临时更新文件 updated_pages.json'));
        }
        
        if (fs.existsSync('pending_data.json')) {
            fs.unlinkSync('pending_data.json');
            console.log(pc.cyan('[INFO] 已删除临时数据文件 pending_data.json'));
        }

    } catch (e) {
        console.error(pc.red('[FATAL] 完成审核过程失败:'), e);
        process.exit(1);
    }
}

// 封装主逻辑，增加错误处理，确保脚本退出状态正确
async function main() {
    // 根据命令行参数决定执行哪种操作
    if (process.argv.includes('--finish-review')) {
        // 完成审核并更新页面
        await finishReviewProcess();
    } else if (process.argv.includes('--find-pending')) {
        // 仅查找待审核项目
        const accessToken = config.oauth2.accessToken || await getOAuth2Token();

        const bot = new Mwn({
            apiUrl: config.apiUrl,
            userAgent: config.userAgent,
            defaultParams: {
                assert: 'user', // 强制要求登录状态
                maxlag: 5 
            }
        });

        const originalRequest = bot.request;
        bot.request = async function(params) {
            // 确保headers中的Authorization值只包含ASCII字符
            if(this.requestOptions.headers && this.requestOptions.headers.Authorization) {
                const authHeader = this.requestOptions.headers.Authorization;
                const cleanAuthHeader = authHeader.split('').filter(char => 
                    char.charCodeAt(0) <= 255
                ).join('');
                this.requestOptions.headers.Authorization = cleanAuthHeader;
            }
            return originalRequest.call(this, params);
        };

        bot.requestOptions.headers = {
            ...bot.requestOptions.headers,
            'Authorization': `Bearer ${accessToken}`
        };

        try {
            console.log(pc.blue('[INFO] 验证登录状态并获取编辑令牌...'));
            await bot.getTokens();
            
            const user = await bot.userinfo();
            console.log(pc.green(`[INFO] 登录成功，当前身份: ${user.name}`));

            await findPendingReviews(bot);
        } catch (e) {
            console.error(pc.red('[FATAL] 初始化失败或认证无效:'), e);
            process.exit(1);
        }
    } else if (process.argv.includes('--update-pages')) {
        // 从JSON文件更新页面
        await finishReviewProcess();
    } else {
        // 默认行为：启动审核流程
        await startReviewProcess();
    }
}

/**
 * 检查用户是否为"熟练编者"
 * 定义：在 2026-02-01 之前已完成 50 次编辑
 */
async function checkVeteranStatus(bot, username) {
    try {
        // API 查询：list=usercontribs
        // ucstart: 从 2026-02-01 开始
        // ucdir: 'older' (默认向旧查询)
        // 含义：查询时间戳早于 2026-02-01 的编辑记录
        const contribs = await bot.request({
            action: 'query',
            list: 'usercontribs',
            ucuser: username,
            ucstart: '2026-02-01T00:00:00Z', // 时间界限
            uclimit: 55, // 获取稍多于 50 条，确认是否满足阈值
            ucdir: 'older'
        });
        
        // 如果返回的列表数 >= 50，说明满足条件
        return contribs.query.usercontribs.length >= 50;
    } catch (err) {
        console.error(pc.yellow(`[WARN] 无法检查用户 ${username} 的资历状态:`), err);
        return false; // 如果检查失败，默认归为新星，避免误判为熟练
    }
}

async function updateLeaderboard(bot, participants) {
    const leaderboardTitle = 'Qiuwen:2026年春节编辑松/提交'; 
    console.log(pc.cyan(`[INFO] 正在更新总排行榜: ${leaderboardTitle}...`));

    try {
        let content = await bot.read(leaderboardTitle).then(res => res.revisions[0].content);

        // 分类排序：
        // 1. 熟练编者 / 新星编者
        // 2. 排序优先级：总分 (降序) -> 条目数 (降序)
        const sortFn = (a, b) => b.totalScore - a.totalScore || b.entryCount - a.entryCount;
        
        const veterans = participants.filter(p => p.isVeteran).sort(sortFn);
        const newStars = participants.filter(p => !p.isVeteran).sort(sortFn);
        const allParticipants = [...participants].sort(sortFn);

        // 生成表格行的辅助函数
        const generateRows = (list, markNewStar = false) => {
            if (list.length === 0) return '|- \n| colspan="5" style="text-align: center;" | 暂无数据\n';
            return list.map((p, index) => {
                let userDisplay = `[[User:${p.username}|${p.username}]]`;
                if (markNewStar && !p.isVeteran) {
                    // 使用显眼的样式标记新星编者
                    userDisplay = `🌱 ${userDisplay}`;
                }

                // 生成一行：| 排名 || 贡献者 || 已提交条数 || 目前得分 || 贡献详情页
                return `|- 
| ${index + 1} || ${userDisplay} || ${p.entryCount} || ${p.totalScore} || [[${p.pageTitle}|查看页面]]`;
            }).join('\n');
        };

        const veteranRows = generateRows(veterans);
        const newStarRows = generateRows(newStars);
        const allRows = generateRows(allParticipants, true);

        // 更新时间戳
        content = updateTimestamp(content);

        // 替换页面中的表格内容
        // 注意：这种正则/字符串替换策略依赖于页面结构保持稳定（{{FakeH3|...}} 标题存在）
        content = replaceTableContent(content, '编者总榜', allRows);
        content = replaceTableContent(content, '熟练编者排行榜', veteranRows);
        content = replaceTableContent(content, '新星编者排行榜', newStarRows);

        // 写入更新后的排行榜
        await bot.save(leaderboardTitle, content, '更新排行榜数据 (2026春节编辑松小工具)');
        console.log(pc.green('[SUCCESS] 总排行榜已更新。'));

    } catch (err) {
        console.error(pc.red('[ERROR] 更新总排行榜失败:'), err);
    }
}

/**
 * 更新页面中的时间戳
 * 在"（以下排行约每小时更新一次）"之后添加最近更新时间
 */
function updateTimestamp(content) {
    // 获取当前时间并转换为 UTC+8（中国标准时间）
    const now = new Date();
    
    // 正确计算 UTC+8 时间：先获取 UTC 时间，再加上 8 小时
    const utc8Time = new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + (8 * 60 * 60 * 1000));
    
    // 格式化时间：xxxx年xx月xx日 xx:xx:xx UTC+8
    const year = utc8Time.getUTCFullYear();
    const month = String(utc8Time.getUTCMonth() + 1).padStart(2, '0');
    const day = String(utc8Time.getUTCDate()).padStart(2, '0');
    const hours = String(utc8Time.getUTCHours()).padStart(2, '0');
    const minutes = String(utc8Time.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc8Time.getUTCSeconds()).padStart(2, '0');
    
    const timestamp = `${year}年${month}月${day}日 ${hours}:${minutes}:${seconds} UTC+8`;
    const timestampLine = `{{center|（最近更新：${timestamp}）}}`;
    
    // 查找"（以下排行约每小时更新一次）"的位置
    const targetText = '{{center|（以下排行约每小时更新一次）}}';
    const targetIndex = content.indexOf(targetText);
    
    if (targetIndex === -1) {
        console.log(pc.yellow('[WARN] 未找到更新提示文本，跳过时间戳更新'));
        return content;
    }
    
    // 查找目标文本之后的下一行
    const afterTarget = targetIndex + targetText.length;
    const nextLineStart = content.indexOf('\n', afterTarget) + 1;
    
    // 检查是否已存在时间戳行
    // 时间戳搜索范围：在目标文本后的前100个字符内查找
    // 这个范围足够覆盖紧跟目标文本的时间戳行，同时避免误匹配页面其他位置的时间戳
    const TIMESTAMP_SEARCH_RANGE = 100;
    const existingTimestampPattern = /\{\{center\|（最近更新：.*?\）\}\}/;
    const contentAfterTarget = content.substring(nextLineStart);
    const timestampMatch = contentAfterTarget.match(existingTimestampPattern);
    
    if (timestampMatch && contentAfterTarget.indexOf(timestampMatch[0]) < TIMESTAMP_SEARCH_RANGE) {
        // 如果已存在时间戳（在目标文本后100个字符内），则替换它
        const oldTimestampIndex = nextLineStart + contentAfterTarget.indexOf(timestampMatch[0]);
        const oldTimestampEnd = oldTimestampIndex + timestampMatch[0].length;
        return content.substring(0, oldTimestampIndex) + timestampLine + content.substring(oldTimestampEnd);
    } else {
        // 如果不存在，则插入新的时间戳行
        return content.substring(0, nextLineStart) + timestampLine + '\n' + content.substring(nextLineStart);
    }
}

function replaceTableContent(fullText, sectionName, newRows) {
    // 1. Find section
    const sectionIndex = fullText.indexOf(sectionName);
    if (sectionIndex === -1) return fullText;

    // 2. Find start of table after section
    const tableStartIndex = fullText.indexOf('{|', sectionIndex);
    if (tableStartIndex === -1) return fullText;

    // 3. Find end of table
    // We need to match nested tables if any? 
    // Assuming simple structure as per sample.
    const tableEndIndex = fullText.indexOf('|}', tableStartIndex);
    if (tableEndIndex === -1) return fullText;

    // 4. Find the header seperator `|-`? 
    // The sample shows:
    // {| ...
    // ! headers
    // |- 
    // | content
    // |}
    // We want to keep headers. The headers usually end with the first `|-` that is NOT followed by `|` or `!` immediately on same line?
    // Actually the standard is `|-` starts a new row.
    // Let's assume the first `|-` after `{|` defines the separation between table decl/headers and body IF headers are used with `!`.
    // BUT the sample:
    // {| class="sf-table"
    // ! style="..." | 排名
    // ...
    // ! style="..." | 贡献详情页
    // |-     <-- Split point
    // | ...
    // |}
    
    const tableContent = fullText.substring(tableStartIndex, tableEndIndex);
    // Find the last header row ending.
    // Usually headers are `! ...`
    // We can assume the *first* `|-` that comes after the last `!` line? 
    // Or just find the first `|-` after the `! ...` block.
    
    // Let's use a standard anchor logic:
    // Look for the header line `! style="width: 20%; text-align:center" | 贡献详情页`
    // The `|-` after that is where we inject.
    
    const headerAnchor = '贡献详情页';
    const headerLoc = tableContent.indexOf(headerAnchor);
    if (headerLoc === -1) return fullText; // Safety
    
    const splitPoint = tableContent.indexOf('|-', headerLoc);
    if (splitPoint === -1) return fullText;
    
    // Construct new table
    const tableHead = tableContent.substring(0, splitPoint);
    const newTable = `${tableHead}${newRows}\n`; // existing part includes start of table up to first |- (exclusive? no |- is start of row)
    
    // Wait, [splitPoint](file://h:\Codes\2026SFE\bot.js#L351-L351) is index of `|-`.
    // If I take 0 to splitPoint, I get headers.
    // Then I add `newRows` (which should start with `|-`).
    // Then close with `|}`.
    
    // Let's verify `newRows` format in `generateRows`: it starts with `|-`.
    // So yes.
    
    const preTable = fullText.substring(0, tableStartIndex);
    const postTable = fullText.substring(tableEndIndex);
    
    return `${preTable}${tableHead}${newRows}\n${postTable}`;
}

function generateGithubSummary(participants) {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;

    const totalParticipants = participants.length;
    const updatedCount = participants.filter(p => p.isUpdated).length;
    const totalEntries = participants.reduce((sum, p) => sum + p.entryCount, 0);
    const totalScore = participants.reduce((sum, p) => sum + p.totalScore, 0);

    const headers = ['用户', '条目数', '得分', '资历', '状态'];
    const rows = participants.sort((a,b) => b.totalScore - a.totalScore).map(p => [
        p.username,
        p.entryCount,
        p.totalScore,
        p.isVeteran ? '✅' : '🆕',
        p.isUpdated ? '📝 已更新' : '无变化'
    ]);

    let markdown = `## 2026年春节编辑松机器人运行摘要 🚀\n\n`;
    markdown += `- **参与总人数**: ${totalParticipants}\n`;
    markdown += `- **本次更新页面数**: ${updatedCount}\n`;
    markdown += `- **总条目数**: ${totalEntries}\n`;
    markdown += `- **总得分**: ${totalScore}\n\n`;

    markdown += `### 参与者详情\n\n`;
    markdown += `| ${headers.join(' | ')} |\n`;
    markdown += `| ${headers.map(() => '---').join(' | ')} |\n`;
    
    rows.forEach(row => {
        markdown += `| ${row.join(' | ')} |\n`;
    });
    
    markdown += `\n摘要生成于 ${new Date().toISOString()}`;

    try {
        fs.appendFileSync(summaryFile, markdown);
    } catch (error) {
        console.error('Error writing to GITHUB_STEP_SUMMARY:', error);
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); // 礼貌延时

main().catch(console.error); // 捕获主函数未处理的异常