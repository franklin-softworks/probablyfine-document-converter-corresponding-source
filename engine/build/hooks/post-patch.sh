#!/bin/bash
# Post-patch hook: Apply skip-empty-columns optimization

DOCIMPORT="/home/dev/workspace/libreoffice/sc/source/core/data/documentimport.cxx"

if [ -f "$DOCIMPORT" ]; then
    # Check if already applied
    if ! grep -q "Skip empty columns" "$DOCIMPORT"; then
        echo "Applying skip-empty-columns optimization..."
        python3 << 'PYEOF'
import sys
with open('/home/dev/workspace/libreoffice/sc/source/core/data/documentimport.cxx', 'r') as f:
    content = f.read()

old_block = '''        ScTable& rTab = *rxTab;
        std::cerr << "[XLSX_DEBUG] Processing tab " << tabNum++ << " cols=" << rTab.aCol.size() << std::endl;
        std::cerr.flush();
        SCCOL nNumCols = rTab.aCol.size();
        for (SCCOL nColIdx = 0; nColIdx < nNumCols; ++nColIdx)
            initColumn(rTab.aCol[nColIdx]);'''

new_block = '''        ScTable& rTab = *rxTab;
        SCCOL nNumCols = rTab.aCol.size();
#ifdef __EMSCRIPTEN__
        // WASM optimization: Skip empty columns to avoid processing all 16384 Excel columns
        SCCOL nProcessedCols = 0;
        for (SCCOL nColIdx = 0; nColIdx < nNumCols; ++nColIdx)
        {
            if (!rTab.aCol[nColIdx].IsEmptyData())
            {
                initColumn(rTab.aCol[nColIdx]);
                ++nProcessedCols;
            }
        }
        std::cerr << "[XLSX_DEBUG] Processing tab " << tabNum++ << " cols=" << nProcessedCols << "/" << nNumCols << " (skipped empty)" << std::endl;
        std::cerr.flush();
#else
        std::cerr << "[XLSX_DEBUG] Processing tab " << tabNum++ << " cols=" << nNumCols << std::endl;
        std::cerr.flush();
        for (SCCOL nColIdx = 0; nColIdx < nNumCols; ++nColIdx)
            initColumn(rTab.aCol[nColIdx]);
#endif'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open('/home/dev/workspace/libreoffice/sc/source/core/data/documentimport.cxx', 'w') as f:
        f.write(content)
    print("Skip-empty-columns optimization applied!")
else:
    print("Block not found (may already be applied)")
PYEOF
    else
        echo "Skip-empty-columns optimization already applied"
    fi
fi
