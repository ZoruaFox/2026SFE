/**
 * 解析用户的贡献页面 Wikitext 代码
 * 返回有效条目行数和总得分
 * 
 * 逻辑:
 * 1. 识别页面中的 Wikitext 表格
 * 2. 查找每一行中是否包含状态模板 {{2026FSEditasonStatus|...|得分}}
 * 3. 统计该模板出现的次数作为条目数，并累加模板中的得分参数
 */
function parseContributionPage(wikitext) {
    let entryCount = 0;
    let totalScore = 0;

    // 按行分割文本，逐行处理
    const lines = wikitext.split('\n');
    let inTable = false;
    
    for (const line of lines) {
        // 检测表格开始
        if (line.trim().startsWith('{|')) {
            inTable = true;
            continue;
        }
        // 检测表格结束
        if (line.trim().startsWith('|}')) {
            inTable = false;
            // 假设我们只关心第一个主要表格，或者全部表格都算（通常只有一个贡献表）
            // 如果有多个表格，可能需要更精细的逻辑
        }
        
        if (inTable) {
            // 预处理：移除行内注释，防止注释中的模板被误统计（如示例行）
            const cleanLine = line.replace(/<!--[\s\S]*?-->/g, '');

            // 过滤：排除导入综述行（通常包含 Special:日志 和 type=import）
            if (cleanLine.includes('type=import') && (cleanLine.includes('Special:日志') || cleanLine.includes('Special:Log'))) {
                continue;
            }

            // 使用正则查找状态模板
            // 模板格式: {{2026SFEditasonStatus|状态|分数(可选)}}
            // 例如: {{2026SFEditasonStatus|pass|5}} 或 {{2026SFEditasonStatus|pass|11.3}}
            // 修改正则：允许匹配小数 ([\d.]+)
            const statusRegex = /\{\{2026SFEditasonStatus\|(.*?)(\|([\d.]+))?\}\}/g;
            let match;
            while ((match = statusRegex.exec(cleanLine)) !== null) {
                // 每发现一个状态模板，视为一行有效条目
                entryCount++;
                
                // 正则第3组捕获的是分数（如果有）
                if (match[3]) {
                    const score = parseFloat(match[3]);
                    // 确保分数是有效数字
                    if (!isNaN(score)) {
                        totalScore += score;
                    }
                }
            }
        }
    }

    return { entryCount, totalScore };
}

/**
 * Updates the mbox in the user page wikitext.
 */
function updateUserPageContent(wikitext, count, score) {
    // Target: {{mbox|type=policy|text={{center|已提交条目数：'''0'''目前得分：'''0'''}}}}
    // Regex allows specific flexible whitespace and decimal numbers
    const mboxRegex = /(\{\{mbox\|type=policy\|text=\{\{center\|已提交条目数：''')(\d+)('''\s*目前得分：''')([\d.]+)('''\}\}\}\})/i;
    
    if (mboxRegex.test(wikitext)) {
        return wikitext.replace(mboxRegex, `$1${count}$3${score}$5`);
    } else {
        return wikitext; 
    }
}

/**
 * Checks if a user is a "Veteran" (50+ edits before 2026-02-01).
 * This requires an API call, so it will be in the main bot.
 */

/**
 * Format score to 2 decimal places
 * @param {number} score - The score to format
 * @returns {number} Score rounded to 2 decimal places
 */
function formatScore(score) {
    return Math.round(score * 100) / 100;
}

module.exports = {
    parseContributionPage,
    updateUserPageContent,
    formatScore
};
