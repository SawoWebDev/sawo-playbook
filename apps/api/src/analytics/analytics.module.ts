import { Controller, Get, Module, Query } from '@nestjs/common';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { AnalyticsService } from './analytics.service';
import { SearchService } from './search.service';

class SummaryQuery {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

class SearchQuery {
  @IsString() @MaxLength(200) q!: string;
}

@Controller()
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly searchService: SearchService,
  ) {}

  @Get('analytics/summary')
  @RequirePermission(Permission.AnalyticsView)
  summary(@CurrentUser() actor: AuthUser, @Query() q: SummaryQuery) {
    return this.analytics.summary(actor, q);
  }

  @Get('search')
  @RequirePermission(Permission.SopView)
  search(@CurrentUser() actor: AuthUser, @Query() q: SearchQuery) {
    return this.searchService.search(actor, q.q);
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, SearchService],
})
export class AnalyticsModule {}
