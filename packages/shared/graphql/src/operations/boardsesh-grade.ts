// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';

export const BOARDSESH_GRADE = gql`
  query BoardseshGrade($boardName: String!, $climbUuid: String!, $angle: Int!) {
    boardseshGrade(boardName: $boardName, climbUuid: $climbUuid, angle: $angle) {
      localGrade
      universalGrade
      contentGrade
      gradeLow
      gradeHigh
      confidence
      ascensionistCount
      modelVersion
      computedAt
    }
  }
`;

export type BoardseshGrade = {
  localGrade: number | null;
  universalGrade: number | null;
  contentGrade?: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  confidence: string;
  ascensionistCount: number;
  modelVersion: string;
  computedAt: string;
};

export type BoardseshGradeVariables = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export type BoardseshGradeResponse = {
  boardseshGrade: BoardseshGrade | null;
};

export const BOARDSESH_GRADES_FOR_ANGLES = gql`
  query BoardseshGradesForAngles($boardName: String!, $climbUuid: String!) {
    boardseshGradesForAngles(boardName: $boardName, climbUuid: $climbUuid) {
      angle
      localGrade
      universalGrade
      contentGrade
      gradeLow
      gradeHigh
      confidence
      ascensionistCount
      modelVersion
      computedAt
    }
  }
`;

export type BoardseshGradeAtAngle = {
  angle: number;
  localGrade: number | null;
  universalGrade: number | null;
  contentGrade?: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  confidence: string;
  ascensionistCount: number;
  modelVersion: string;
  computedAt: string;
};

export type BoardseshGradesForAnglesVariables = {
  boardName: string;
  climbUuid: string;
};

export type BoardseshGradesForAnglesResponse = {
  boardseshGradesForAngles: BoardseshGradeAtAngle[];
};
