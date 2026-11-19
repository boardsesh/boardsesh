'use client';

/**
 * GraphQL Schema Viewer Component
 *
 * Displays the GraphQL schema documentation with syntax highlighting.
 * The schema is loaded from the shared-schema package.
 *
 * Uses a tokenizer-based approach for syntax highlighting to avoid XSS
 * vulnerabilities from dangerouslySetInnerHTML.
 */

import { useState, type ReactNode } from 'react';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import ClearOutlined from '@mui/icons-material/ClearOutlined';
import IconButton from '@mui/material/IconButton';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Chip from '@mui/material/Chip';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import { typeDefs as typeDefsArray } from '@boardsesh/shared-schema/schema';
import { TabPanel } from '@/app/components/ui/tab-panel';
import { themeTokens } from '@/app/theme/theme-config';
import { tokenizeLine } from './graphql-tokenizer';
import styles from './docs.module.css';

const typeDefs = typeDefsArray.join('\n');

// Typography destructuring removed - using MUI Typography directly

type SchemaSection = {
  name: string;
  content: string;
  type: 'type' | 'input' | 'enum' | 'query' | 'mutation' | 'subscription' | 'union' | 'scalar';
};

/**
 * Renders syntax-highlighted GraphQL code using React elements.
 * Safe from XSS as it doesn't use dangerouslySetInnerHTML.
 */
function highlightGraphQL(code: string): ReactNode[] {
  const lines = code.split('\n');

  return lines.map((line, lineIndex) => {
    const tokens = tokenizeLine(line);

    return (
      <span key={lineIndex}>
        {tokens.map((token, tokenIndex) => (
          <span key={tokenIndex} style={{ color: themeTokens.syntax[token.type] }}>
            {token.text}
          </span>
        ))}
        {lineIndex < lines.length - 1 && '\n'}
      </span>
    );
  });
}

function parseSchema(schema: string): SchemaSection[] {
  const sections: SchemaSection[] = [];
  const lines = schema.split('\n');
  let currentSection: SchemaSection | null = null;
  let braceCount = 0;

  for (const line of lines) {
    // Detect start of a new type definition
    const typeMatch = line.match(/^\s*("""[\s\S]*?"""\s*)?(type|input|enum|union|scalar)\s+(\w+)/);
    const queryMatch = line.match(/^\s*("""[\s\S]*?""")?\s*type\s+(Query|Mutation|Subscription)\s*\{/);

    if (queryMatch) {
      if (currentSection && braceCount === 0) {
        sections.push(currentSection);
      }
      const typeName = queryMatch[2].toLowerCase() as 'query' | 'mutation' | 'subscription';
      currentSection = {
        name: queryMatch[2],
        content: line,
        type: typeName,
      };
      braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    } else if (typeMatch && !queryMatch) {
      if (currentSection && braceCount === 0) {
        sections.push(currentSection);
      }
      currentSection = {
        name: typeMatch[3],
        content: line,
        type: typeMatch[2] as SchemaSection['type'],
      };
      braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    } else if (currentSection) {
      currentSection.content += '\n' + line;
      braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

      if (braceCount === 0 && line.trim() === '}') {
        sections.push(currentSection);
        currentSection = null;
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

const chipColors: Record<
  SchemaSection['type'],
  'primary' | 'success' | 'secondary' | 'info' | 'warning' | 'error' | 'default'
> = {
  type: 'primary',
  input: 'success',
  enum: 'secondary',
  query: 'info',
  mutation: 'warning',
  subscription: 'error',
  union: 'warning',
  scalar: 'default',
};

function TypeBadge({ type }: { type: SchemaSection['type'] }) {
  return <Chip label={type.toUpperCase()} color={chipColors[type]} size="small" />;
}

function SchemaBlock({ content }: { content: string }) {
  return (
    <pre className={styles.schemaBlock}>
      <code>{highlightGraphQL(content)}</code>
    </pre>
  );
}

export default function GraphQLSchemaViewer() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('operations');
  const sections = parseSchema(typeDefs);

  const filteredSections = searchQuery
    ? sections.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.content.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : sections;

  const groupedSections = {
    operations: filteredSections.filter((s) => ['query', 'mutation', 'subscription'].includes(s.type)),
    types: filteredSections.filter(
      (s) => s.type === 'type' && !['query', 'mutation', 'subscription'].includes(s.name.toLowerCase()),
    ),
    inputs: filteredSections.filter((s) => s.type === 'input'),
    enums: filteredSections.filter((s) => s.type === 'enum'),
    others: filteredSections.filter((s) => ['union', 'scalar'].includes(s.type)),
  };

  const renderSectionList = (sectionList: SchemaSection[]) => (
    <>
      {sectionList.map((section) => (
        <Accordion key={section.name}>
          <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
            <Stack direction="row" spacing={1}>
              <TypeBadge type={section.type} />
              <Typography variant="body2" component="span" fontWeight={600}>
                {section.name}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <SchemaBlock content={section.content} />
          </AccordionDetails>
        </Accordion>
      ))}
    </>
  );

  return (
    <div>
      <div className={styles.searchContainer}>
        <TextField
          // i18n-ignore-next-line -- technical reference, English only
          placeholder="Search types, fields, descriptions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={styles.searchInput}
          size="small"
          fullWidth
          slotProps={{
            input: {
              endAdornment: searchQuery ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearchQuery('')}>
                    <ClearOutlined fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
      </div>

      <Tabs
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        value={activeTab}
        onChange={(_, v) => setActiveTab(v)}
      >
        <Tab label={`Operations (${groupedSections.operations.length})`} value="operations" />
        <Tab label={`Types (${groupedSections.types.length})`} value="types" />
        <Tab label={`Inputs (${groupedSections.inputs.length})`} value="inputs" />
        <Tab label={`Enums (${groupedSections.enums.length})`} value="enums" />
        <Tab label={`Others (${groupedSections.others.length})`} value="others" />
        {/* i18n-ignore-next-line -- technical reference, English only */}
        <Tab label="Full Schema" value="full" />
      </Tabs>

      <TabPanel value={activeTab} index="operations">
        <div>
          <Typography variant="body1" component="p" color="text.secondary" className={styles.operationsDescription}>
            {/* i18n-ignore-next-line -- technical reference, English only */}
            Queries, Mutations, and Subscriptions available via the WebSocket GraphQL API.
          </Typography>
          {renderSectionList(groupedSections.operations)}
        </div>
      </TabPanel>

      <TabPanel value={activeTab} index="types">
        {renderSectionList(groupedSections.types)}
      </TabPanel>

      <TabPanel value={activeTab} index="inputs">
        {renderSectionList(groupedSections.inputs)}
      </TabPanel>

      <TabPanel value={activeTab} index="enums">
        {renderSectionList(groupedSections.enums)}
      </TabPanel>

      <TabPanel value={activeTab} index="others">
        {renderSectionList(groupedSections.others)}
      </TabPanel>

      <TabPanel value={activeTab} index="full">
        <MuiCard>
          <CardContent>
            <SchemaBlock content={typeDefs} />
          </CardContent>
        </MuiCard>
      </TabPanel>
    </div>
  );
}
