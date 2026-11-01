import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  financialOverviewQuerySchema, loanImportCommitRequestSchema, loanImportDeleteRequestSchema,
  loanImportPreviewRequestSchema, loanImportUpdateRequestSchema,
} from '@family/contracts';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { LoanImportService } from './loan-import.service';

class HouseholdQueryDto extends createZodDto(z.object({ householdId: z.string().uuid() }).strict()) {}
class PreviewDto extends createZodDto(loanImportPreviewRequestSchema) {}
class CommitDto extends createZodDto(loanImportCommitRequestSchema) {}
class UpdateDto extends createZodDto(loanImportUpdateRequestSchema) {}
class DeleteDto extends createZodDto(loanImportDeleteRequestSchema) {}
class OverviewDto extends createZodDto(financialOverviewQuerySchema) {}

/** Normal authenticated users only; browser captures never authenticate a user. */
@Controller('loan-imports')
export class LoanImportController {
  constructor(private readonly service: LoanImportService) {}

  @Post('preview') @HttpCode(200) @Header('Cache-Control', 'no-store')
  preview(@CurrentUser() user: AuthenticatedUser, @Body() input: PreviewDto) {
    return this.service.preview(user.userId, input);
  }

  @Post('commit') @HttpCode(200) @Header('Cache-Control', 'no-store')
  commit(@CurrentUser() user: AuthenticatedUser, @Body() input: CommitDto) {
    return this.service.commit(user.userId, input);
  }

  @Get('records') @Header('Cache-Control', 'no-store')
  records(@CurrentUser() user: AuthenticatedUser, @Query() query: HouseholdQueryDto) {
    return this.service.records(user.userId, query.householdId);
  }

  @Patch('records/:id') @Header('Cache-Control', 'no-store')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: HouseholdQueryDto, @Body() input: UpdateDto) {
    return this.service.update(user.userId, query.householdId, id, input);
  }

  @Delete('records/:id') @Header('Cache-Control', 'no-store')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: HouseholdQueryDto, @Body() input: DeleteDto) {
    return this.service.remove(user.userId, query.householdId, id, input);
  }
}

@Controller('financial-overview')
export class FinancialOverviewController {
  constructor(private readonly service: LoanImportService) {}

  @Get() @Header('Cache-Control', 'no-store')
  overview(@CurrentUser() user: AuthenticatedUser, @Query() query: OverviewDto) {
    return this.service.overview(user.userId, query);
  }
}
